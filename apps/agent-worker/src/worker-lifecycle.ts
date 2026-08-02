import { createHash } from 'node:crypto';
import { ModelPolicyCatalog } from '@agentpress/agent-context';

import {
  AGENT_RUN_CANCEL_CHANNEL,
  AGENT_RUN_STEER_CHANNEL,
  AGENT_RUN_COMMAND_TOPIC,
  DirectRunService,
  type LiveRunEvent,
  type RunEventPublisher,
} from '@agentpress/agent-application';
import { PiRuntimeAdapter } from '@agentpress/agent-runtime';
import { loadWorkerEnvironment, type WorkerEnvironment } from '@agentpress/config';
import {
  claimOutboxMessages,
  connectDatabase,
  markOutboxMessagePublished,
  processInboxMessage,
  releaseOutboxMessage,
  type DatabaseConnection,
} from '@agentpress/database';
import { createServiceLogger } from '@agentpress/observability';
import { createBuiltInToolRuntime } from '@agentpress/runtime-tools';
import {
  ArkEmbeddingProvider,
  ArticleKnowledgeIndexer,
  ARTICLE_INDEX_COMMAND_TOPIC,
} from '@agentpress/knowledge-retrieval';
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Kafka, Partitioners } from 'kafkajs';

import { runWithKafkaHeartbeat } from './kafka-heartbeat.js';
import {
  AGENT_RUN_PARTITIONS,
  ARTICLE_INDEX_PARTITIONS,
  ensureKafkaTopics,
} from './kafka-topics.js';
import { RedisRunLeaseManager } from './redis-run-lease.js';

const RUN_EVENT_CHANNEL_PREFIX = 'agentpress:run:events:';
const CONSUMER_GROUP = 'agentpress-agent-worker-v1';
const INDEX_CONSUMER_GROUP = 'agentpress-knowledge-worker-v1';
const OUTBOX_INTERVAL_MS = 250;

@Injectable()
export class WorkerLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly environment: WorkerEnvironment = loadWorkerEnvironment();
  private readonly logger = createServiceLogger({
    level: this.environment.logLevel,
    service: 'agent-worker',
  });
  private readonly database: DatabaseConnection = connectDatabase(this.environment.databaseUrl);
  private readonly redisPublisher = new Redis(this.environment.redisUrl, {
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  private readonly redisSubscriber = this.redisPublisher.duplicate({
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  private readonly kafka = new Kafka({
    brokers: [...this.environment.kafkaBrokers],
    clientId: `agentpress-agent-worker-${String(process.pid)}`,
  });
  private readonly producer = this.kafka.producer({
    createPartitioner: Partitioners.DefaultPartitioner,
    idempotent: true,
    maxInFlightRequests: 1,
  });
  private readonly consumer = this.kafka.consumer({
    groupId: CONSUMER_GROUP,
  });
  private readonly indexConsumer = this.kafka.consumer({ groupId: INDEX_CONSUMER_GROUP });
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly runLeases = new RedisRunLeaseManager(this.redisPublisher);
  private readonly builtInTools = createBuiltInToolRuntime(
    this.database.db,
    this.createEventPublisher(),
  );
  private readonly runService = new DirectRunService({
    database: this.database.db,
    publisher: this.createEventPublisher(),
    runtimeToolFactory: this.builtInTools.bridge,
    runtimeFactory: {
      create: (task = 'direct') => {
        const proModel = this.environment.agentModelPro ?? this.environment.arkModelPro;
        if (!proModel) {
          throw new Error(
            'AGENT_MODEL_PRO or ARK_MODEL_PRO is required to execute a real Agent Run',
          );
        }
        const turboModel = this.environment.agentModelPro
          ? this.environment.agentModelTurbo
          : this.environment.arkModelTurbo;
        const selection = createModelPolicies(proModel, turboModel).select(task);
        if (
          this.environment.agentModelApiKey &&
          this.environment.agentModelBaseUrl &&
          this.environment.agentModelPro
        ) {
          return PiRuntimeAdapter.forOpenAICompatible({
            providerId: 'agent-model',
            providerName: 'Agent model',
            modelId: selection.model,
            baseUrl: this.environment.agentModelBaseUrl,
            apiKey: this.environment.agentModelApiKey,
          });
        }
        return PiRuntimeAdapter.forArk({
          modelId: selection.model,
          baseUrl: this.environment.arkBaseUrl,
          ...(this.environment.arkApiKey ? { apiKey: this.environment.arkApiKey } : {}),
        });
      },
    },
    systemPrompt:
      'You are AgentPress, a precise long-form writing agent. Use available research tools when facts need evidence. Preserve citations and state uncertainty. For illustrated articles, generate an image first, then call article.propose_edits to insert an image block containing assetId, contentUrl as src, prompt, model and provenance. Never claim the article changed until the user accepts the proposal.',
  });
  private readonly articleIndexer =
    this.environment.arkApiKey && this.environment.arkEmbeddingModel
      ? new ArticleKnowledgeIndexer(
          this.database.db,
          new ArkEmbeddingProvider({
            apiKey: this.environment.arkApiKey,
            baseUrl: this.environment.arkBaseUrl,
            model: this.environment.arkEmbeddingModel,
          }),
        )
      : undefined;
  private outboxTimer: NodeJS.Timeout | undefined;
  private dispatching = false;
  private stopping = false;

  public async onModuleInit(): Promise<void> {
    await this.ensureTopics();
    await Promise.all([
      this.redisPublisher.connect(),
      this.redisSubscriber.connect(),
      this.producer.connect(),
      this.consumer.connect(),
      ...(this.articleIndexer ? [this.indexConsumer.connect()] : []),
    ]);
    this.redisSubscriber.on('message', (channel: string, runId: string) => {
      if (channel === AGENT_RUN_CANCEL_CHANNEL) {
        this.activeRuns.get(runId)?.abort();
        return;
      }
      if (channel === AGENT_RUN_STEER_CHANNEL) {
        const command = parseSteeringCommand(runId);
        if (command) {
          void this.runService.steerActiveMain(command.runId, command.directiveId, command.content);
        }
      }
    });
    await this.redisSubscriber.subscribe(AGENT_RUN_CANCEL_CHANNEL, AGENT_RUN_STEER_CHANNEL);
    await this.consumer.subscribe({ topics: [AGENT_RUN_COMMAND_TOPIC], fromBeginning: true });
    if (this.articleIndexer) {
      await this.indexConsumer.subscribe({
        topics: [ARTICLE_INDEX_COMMAND_TOPIC],
        fromBeginning: true,
      });
    }
    await this.consumer.run({
      partitionsConsumedConcurrently: AGENT_RUN_PARTITIONS,
      eachMessage: async (payload) => {
        const { topic, partition, message } = payload;
        await runWithKafkaHeartbeat(
          () =>
            this.handleCommand(topic, partition, Number(message.offset), message.value?.toString()),
          () => payload.heartbeat(),
          {
            onHeartbeatError: (error) => {
              this.logger.warn({ err: error, topic, partition }, 'Kafka heartbeat failed');
            },
          },
        );
      },
    });
    if (this.articleIndexer) {
      await this.indexConsumer.run({
        partitionsConsumedConcurrently: ARTICLE_INDEX_PARTITIONS,
        eachMessage: async (payload) => {
          const { topic, partition, message } = payload;
          await runWithKafkaHeartbeat(
            () =>
              this.handleIndexCommand(
                topic,
                partition,
                Number(message.offset),
                message.value?.toString(),
              ),
            () => payload.heartbeat(),
            {
              onHeartbeatError: (error) => {
                this.logger.warn({ err: error, topic, partition }, 'Kafka heartbeat failed');
              },
            },
          );
        },
      });
    } else {
      this.logger.warn(
        { topic: ARTICLE_INDEX_COMMAND_TOPIC },
        'Article indexing consumer disabled until Ark embedding is configured',
      );
    }
    this.outboxTimer = setInterval(() => {
      void this.dispatchOutbox();
    }, OUTBOX_INTERVAL_MS);
    await this.dispatchOutbox();
    this.logger.info(
      { brokers: this.environment.kafkaBrokers, topic: AGENT_RUN_COMMAND_TOPIC },
      'Agent worker transports started',
    );
  }

  private async ensureTopics(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      await ensureKafkaTopics(admin, [
        { topic: AGENT_RUN_COMMAND_TOPIC, partitions: AGENT_RUN_PARTITIONS },
        { topic: ARTICLE_INDEX_COMMAND_TOPIC, partitions: ARTICLE_INDEX_PARTITIONS },
      ]);
    } finally {
      await admin.disconnect();
    }
  }

  public async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
    }
    for (const controller of this.activeRuns.values()) {
      controller.abort();
    }
    await Promise.allSettled([
      this.consumer.disconnect(),
      ...(this.articleIndexer ? [this.indexConsumer.disconnect()] : []),
      this.producer.disconnect(),
      this.redisSubscriber.unsubscribe(AGENT_RUN_CANCEL_CHANNEL, AGENT_RUN_STEER_CHANNEL),
      ...(['web_research', 'workspace_knowledge', 'licensed_media'] as const).map((serverId) =>
        this.builtInTools.manager.stop(serverId),
      ),
    ]);
    this.redisSubscriber.disconnect();
    if (this.redisPublisher.status === 'wait') {
      this.redisPublisher.disconnect();
    } else if (this.redisPublisher.status !== 'end') {
      await this.redisPublisher.quit();
    }
    await this.database.close();
  }

  private createEventPublisher(): RunEventPublisher {
    return {
      publish: async (event: LiveRunEvent) => {
        const runId = event.durable ? event.event.runId : event.runId;
        await this.redisPublisher.publish(
          `${RUN_EVENT_CHANNEL_PREFIX}${runId}`,
          JSON.stringify(event),
        );
      },
    };
  }

  private async handleCommand(
    topic: string,
    partition: number,
    offset: number,
    rawPayload: string | undefined,
  ): Promise<void> {
    const command = parseRunCommand(rawPayload);
    if (!command) {
      this.logger.warn({ topic, partition, offset }, 'Discarded invalid Agent Run command');
      return;
    }
    const controller = new AbortController();
    const lease = await this.runLeases.acquire(command.runId, () => {
      controller.abort();
    });
    if (!lease) {
      this.logger.info({ runId: command.runId }, 'Skipped duplicate Agent Run command');
      return;
    }
    this.activeRuns.set(command.runId, controller);
    try {
      await this.runService.prepareRecovery(command.runId);
      const result = await this.runService.execute(command.runId, controller.signal);
      await processInboxMessage(
        this.database.db,
        {
          consumerGroup: CONSUMER_GROUP,
          messageId: command.messageId,
          topic,
          partition,
          offset,
          payloadHash: createHash('sha256')
            .update(rawPayload ?? '')
            .digest('hex'),
        },
        () => Promise.resolve(),
      );
      this.logger.info({ runId: command.runId, status: result.status }, 'Agent Run settled');
    } catch (error) {
      this.logger.error({ err: error, runId: command.runId }, 'Agent Run execution failed');
      throw error;
    } finally {
      this.activeRuns.delete(command.runId);
      await lease.release();
    }
  }

  private async handleIndexCommand(
    topic: string,
    partition: number,
    offset: number,
    rawPayload: string | undefined,
  ): Promise<void> {
    const command = parseIndexCommand(rawPayload);
    if (!command) {
      this.logger.warn({ topic, partition, offset }, 'Discarded invalid article index command');
      return;
    }
    if (!this.articleIndexer)
      throw new Error('ARK_API_KEY and ARK_EMBEDDING_MODEL are required for article indexing');
    await this.articleIndexer.indexRevision(command.revisionId);
    await processInboxMessage(
      this.database.db,
      {
        consumerGroup: INDEX_CONSUMER_GROUP,
        messageId: command.messageId,
        topic,
        partition,
        offset,
        payloadHash: createHash('sha256')
          .update(rawPayload ?? '')
          .digest('hex'),
      },
      () => Promise.resolve(),
    );
    this.logger.info({ revisionId: command.revisionId }, 'Article revision indexed');
  }

  private async dispatchOutbox(): Promise<void> {
    if (this.dispatching || this.stopping) {
      return;
    }
    this.dispatching = true;
    const workerId = `agent-worker:${String(process.pid)}`;
    try {
      const messages = await claimOutboxMessages(this.database.db, workerId, 50);
      for (const message of messages) {
        try {
          await this.producer.send({
            topic: message.topic,
            messages: [
              {
                key: message.messageKey,
                value: JSON.stringify(message.payload),
                headers: message.headers,
              },
            ],
          });
          await markOutboxMessagePublished(this.database.db, message.id, workerId, new Date());
        } catch (error) {
          const delaySeconds = Math.min(60, 2 ** Math.min(message.attempts, 6));
          await releaseOutboxMessage(
            this.database.db,
            message.id,
            workerId,
            new Date(Date.now() + delaySeconds * 1_000),
            error instanceof Error ? error.message : 'Unknown Kafka publish error',
          );
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
}

type RunCommand = {
  readonly command: 'run.execute';
  readonly messageId: string;
  readonly runId: string;
};

function parseRunCommand(payload: string | undefined): RunCommand | undefined {
  if (!payload) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('command' in value) ||
      value.command !== 'run.execute' ||
      !('messageId' in value) ||
      typeof value.messageId !== 'string' ||
      !('runId' in value) ||
      typeof value.runId !== 'string'
    ) {
      return undefined;
    }
    return value as RunCommand;
  } catch {
    return undefined;
  }
}

type SteeringCommand = {
  readonly runId: string;
  readonly directiveId: string;
  readonly content: string;
};

function parseSteeringCommand(payload: string | undefined): SteeringCommand | undefined {
  if (!payload) return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('runId' in value) ||
      typeof value.runId !== 'string' ||
      !('directiveId' in value) ||
      typeof value.directiveId !== 'string' ||
      !('content' in value) ||
      typeof value.content !== 'string'
    )
      return undefined;
    return value as SteeringCommand;
  } catch {
    return undefined;
  }
}

type IndexCommand = {
  readonly command: 'article.index';
  readonly messageId: string;
  readonly revisionId: string;
};

function parseIndexCommand(payload: string | undefined): IndexCommand | undefined {
  if (!payload) return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('command' in value) ||
      value.command !== 'article.index' ||
      !('messageId' in value) ||
      typeof value.messageId !== 'string' ||
      !('revisionId' in value) ||
      typeof value.revisionId !== 'string'
    )
      return undefined;
    return value as IndexCommand;
  } catch {
    return undefined;
  }
}

function createModelPolicies(proModel: string, turboModel?: string): ModelPolicyCatalog {
  const fastModel = turboModel ?? proModel;
  const policy = (task: string, primary: string, fallbacks: readonly string[]) => ({
    task,
    primary,
    fallbacks,
    embeddingModel: 'configured-by-rag-provider',
    rerankModel: 'configured-by-rag-provider',
    imageModel: 'configured-by-media-provider',
  });
  return new ModelPolicyCatalog([
    policy('main', proModel, fastModel === proModel ? [] : [fastModel]),
    policy('direct', proModel, fastModel === proModel ? [] : [fastModel]),
    policy('researcher', fastModel, fastModel === proModel ? [] : [proModel]),
    policy('fact_checker', fastModel, fastModel === proModel ? [] : [proModel]),
    policy('writer', proModel, fastModel === proModel ? [] : [fastModel]),
    policy('editor', proModel, fastModel === proModel ? [] : [fastModel]),
    policy('illustrator', proModel, fastModel === proModel ? [] : [fastModel]),
    policy('synthesis', proModel, fastModel === proModel ? [] : [fastModel]),
  ]);
}

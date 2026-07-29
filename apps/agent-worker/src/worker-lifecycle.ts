import { createHash } from 'node:crypto';

import {
  AGENT_RUN_CANCEL_CHANNEL,
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
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';

const RUN_EVENT_CHANNEL_PREFIX = 'agentpress:run:events:';
const CONSUMER_GROUP = 'agentpress-agent-worker-v1';
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
  private readonly kafka = new KafkaJS.Kafka({
    'bootstrap.servers': this.environment.kafkaBrokers.join(','),
    'client.id': `agentpress-agent-worker-${String(process.pid)}`,
  });
  private readonly producer = this.kafka.producer({
    'enable.idempotence': true,
    acks: -1,
  });
  private readonly consumer = this.kafka.consumer({
    'group.id': CONSUMER_GROUP,
    'auto.offset.reset': 'earliest',
    'enable.auto.commit': true,
  });
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly runService = new DirectRunService({
    database: this.database.db,
    publisher: this.createEventPublisher(),
    runtimeFactory: {
      create: () => {
        if (!this.environment.arkModelPro) {
          throw new Error('ARK_MODEL_PRO is required to execute a real Agent Run');
        }
        return PiRuntimeAdapter.forArk({
          modelId: this.environment.arkModelPro,
          baseUrl: this.environment.arkBaseUrl,
          ...(this.environment.arkApiKey ? { apiKey: this.environment.arkApiKey } : {}),
        });
      },
    },
    systemPrompt:
      'You are AgentPress, a precise long-form writing agent. Preserve evidence and state uncertainty.',
  });
  private outboxTimer: NodeJS.Timeout | undefined;
  private dispatching = false;
  private stopping = false;

  public async onModuleInit(): Promise<void> {
    await Promise.all([
      this.redisPublisher.connect(),
      this.redisSubscriber.connect(),
      this.producer.connect(),
      this.consumer.connect(),
    ]);
    this.redisSubscriber.on('message', (channel: string, runId: string) => {
      if (channel === AGENT_RUN_CANCEL_CHANNEL) {
        this.activeRuns.get(runId)?.abort();
      }
    });
    await this.redisSubscriber.subscribe(AGENT_RUN_CANCEL_CHANNEL);
    await this.consumer.subscribe({ topics: [AGENT_RUN_COMMAND_TOPIC] });
    await this.consumer.run({
      partitionsConsumedConcurrently: 8,
      eachMessage: async ({ topic, partition, message }) => {
        await this.handleCommand(
          topic,
          partition,
          Number(message.offset),
          message.value?.toString(),
        );
      },
    });
    this.outboxTimer = setInterval(() => {
      void this.dispatchOutbox();
    }, OUTBOX_INTERVAL_MS);
    await this.dispatchOutbox();
    this.logger.info(
      { brokers: this.environment.kafkaBrokers, topic: AGENT_RUN_COMMAND_TOPIC },
      'Agent worker transports started',
    );
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
      this.producer.disconnect(),
      this.redisSubscriber.unsubscribe(AGENT_RUN_CANCEL_CHANNEL),
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
    this.activeRuns.set(command.runId, controller);
    try {
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
    }
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

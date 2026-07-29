import { createHash } from 'node:crypto';

import { loadWorkerEnvironment } from '@agentpress/config';
import {
  claimOutboxMessages,
  connectDatabase,
  markOutboxMessagePublished,
  processInboxMessage,
  releaseOutboxMessage,
} from '@agentpress/database';
import { createServiceLogger } from '@agentpress/observability';
import {
  PUBLICATION_EVENT_TOPIC,
  PUBLICATION_RANKING_CONSUMER_GROUP,
  projectPublicationRanking,
  type PublicationEvent,
} from '@agentpress/publication-application';
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Kafka, Partitioners } from 'kafkajs';

const OUTBOX_INTERVAL_MS = 250;

@Injectable()
export class WorkerLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly environment = loadWorkerEnvironment();
  private readonly logger = createServiceLogger({
    level: this.environment.logLevel,
    service: 'async-worker',
  });
  private readonly database = connectDatabase(this.environment.databaseUrl);
  private readonly kafka = new Kafka({
    brokers: [...this.environment.kafkaBrokers],
    clientId: `agentpress-async-worker-${String(process.pid)}`,
  });
  private readonly producer = this.kafka.producer({
    createPartitioner: Partitioners.DefaultPartitioner,
    idempotent: true,
    maxInFlightRequests: 1,
  });
  private readonly consumer = this.kafka.consumer({
    groupId: PUBLICATION_RANKING_CONSUMER_GROUP,
  });
  private outboxTimer: NodeJS.Timeout | undefined;
  private dispatching = false;
  private stopping = false;

  public async onModuleInit(): Promise<void> {
    await this.ensureTopic();
    await Promise.all([this.producer.connect(), this.consumer.connect()]);
    await this.consumer.subscribe({ topics: [PUBLICATION_EVENT_TOPIC], fromBeginning: true });
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const raw = message.value?.toString();
        const event = parsePublicationEvent(raw);
        if (!event) {
          this.logger.warn(
            { topic, partition, offset: message.offset },
            'Invalid publication event',
          );
          return;
        }
        await processInboxMessage(
          this.database.db,
          {
            consumerGroup: PUBLICATION_RANKING_CONSUMER_GROUP,
            messageId: event.messageId,
            topic,
            partition,
            offset: Number(message.offset),
            payloadHash: createHash('sha256')
              .update(raw ?? '')
              .digest('hex'),
          },
          (transaction) => projectPublicationRanking(transaction, event.publicationId),
        );
      },
    });
    this.outboxTimer = setInterval(() => {
      void this.dispatchOutbox();
    }, OUTBOX_INTERVAL_MS);
    await this.dispatchOutbox();
    this.logger.info({ topic: PUBLICATION_EVENT_TOPIC }, 'Publication ranking worker started');
  }

  private async ensureTopic(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      if ((await admin.listTopics()).includes(PUBLICATION_EVENT_TOPIC)) return;
      await admin.createTopics({
        topics: [{ topic: PUBLICATION_EVENT_TOPIC }],
        waitForLeaders: true,
      });
    } finally {
      await admin.disconnect();
    }
  }

  public async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    await Promise.allSettled([this.consumer.disconnect(), this.producer.disconnect()]);
    await this.database.close();
  }

  private async dispatchOutbox(): Promise<void> {
    if (this.dispatching || this.stopping) return;
    this.dispatching = true;
    const workerId = `async-worker:${String(process.pid)}`;
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

function parsePublicationEvent(value: string | undefined): PublicationEvent | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('messageId' in parsed) ||
      typeof parsed.messageId !== 'string' ||
      !('publicationId' in parsed) ||
      typeof parsed.publicationId !== 'string' ||
      !('occurredAt' in parsed) ||
      typeof parsed.occurredAt !== 'string' ||
      !('type' in parsed) ||
      !['publication.published', 'publication.reacted', 'publication.viewed'].includes(
        String(parsed.type),
      )
    ) {
      return undefined;
    }
    return parsed as PublicationEvent;
  } catch {
    return undefined;
  }
}

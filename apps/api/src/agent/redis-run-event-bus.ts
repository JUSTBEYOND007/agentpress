import {
  AGENT_RUN_CANCEL_CHANNEL,
  AGENT_RUN_STEER_CHANNEL,
  type RunSteeringCommand,
  type LiveRunEvent,
  type RunEventPublisher,
} from '@agentpress/agent-application';
import { Redis } from 'ioredis';

const RUN_EVENT_CHANNEL_PREFIX = 'agentpress:run:events:';

export type RunEventListener = (event: LiveRunEvent) => void;

export class RedisRunEventBus implements RunEventPublisher {
  private readonly publisher: Redis;

  public constructor(redisUrl: string) {
    this.publisher = new Redis(redisUrl, {
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }

  public async publish(event: LiveRunEvent): Promise<void> {
    const runId = event.durable ? event.event.runId : event.runId;
    await this.ensurePublisherConnected();
    await this.publisher.publish(`${RUN_EVENT_CHANNEL_PREFIX}${runId}`, JSON.stringify(event));
  }

  public async publishCancellation(runId: string): Promise<void> {
    await this.ensurePublisherConnected();
    await this.publisher.publish(AGENT_RUN_CANCEL_CHANNEL, runId);
  }

  public async publishSteering(command: RunSteeringCommand): Promise<void> {
    await this.ensurePublisherConnected();
    await this.publisher.publish(AGENT_RUN_STEER_CHANNEL, JSON.stringify(command));
  }

  public async subscribe(runId: string, listener: RunEventListener): Promise<() => Promise<void>> {
    const subscriber = this.publisher.duplicate({
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    await subscriber.connect();
    const channel = `${RUN_EVENT_CHANNEL_PREFIX}${runId}`;
    subscriber.on('message', (receivedChannel: string, payload: string) => {
      if (receivedChannel !== channel) {
        return;
      }
      const event = parseLiveRunEvent(payload);
      if (event) {
        listener(event);
      }
    });
    await subscriber.subscribe(channel);

    return async () => {
      await subscriber.unsubscribe(channel);
      subscriber.disconnect();
    };
  }

  public async close(): Promise<void> {
    if (this.publisher.status === 'wait') {
      this.publisher.disconnect();
    } else if (this.publisher.status !== 'end') {
      await this.publisher.quit();
    }
  }

  private async ensurePublisherConnected(): Promise<void> {
    if (this.publisher.status === 'wait') {
      await this.publisher.connect();
    }
  }
}

function parseLiveRunEvent(payload: string): LiveRunEvent | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('durable' in value) ||
      typeof value.durable !== 'boolean'
    ) {
      return undefined;
    }
    if (value.durable) {
      if (
        !('event' in value) ||
        typeof value.event !== 'object' ||
        value.event === null ||
        !('createdAt' in value.event) ||
        typeof value.event.createdAt !== 'string'
      ) {
        return undefined;
      }
      const createdAt = new Date(value.event.createdAt);
      if (Number.isNaN(createdAt.getTime())) {
        return undefined;
      }
      return { durable: true, event: { ...value.event, createdAt } } as LiveRunEvent;
    }
    return value as LiveRunEvent;
  } catch {
    return undefined;
  }
}

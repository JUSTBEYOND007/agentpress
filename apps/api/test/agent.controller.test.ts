import type {
  DirectRunService,
  DurableRunEvent,
  LiveRunEvent,
} from '@agentpress/agent-application';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AgentController } from '../src/agent/agent.controller.js';
import type { RedisRunEventBus } from '../src/agent/redis-run-event-bus.js';

describe('AgentController SSE replay', () => {
  it('buffers live events until durable replay is emitted in sequence order', async () => {
    const replay = [durableEvent(1), durableEvent(2)];
    const live = durableEvent(3);
    const runs = {
      listEvents: () => Promise.resolve(replay),
    } as unknown as DirectRunService;
    const eventBus = {
      subscribe(_runId: string, listener: (event: LiveRunEvent) => void) {
        listener({ durable: true, event: live });
        return Promise.resolve(() => Promise.resolve());
      },
    } as unknown as RedisRunEventBus;
    const controller = new AgentController(runs, eventBus);
    const ids: string[] = [];

    const subscription = controller.streamEvents('run-1', '0').subscribe((event) => {
      if (event.id) {
        ids.push(event.id);
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    subscription.unsubscribe();

    expect(ids).toEqual(['1', '2', '3']);
  });

  it('rejects an invalid Last-Event-ID', () => {
    const controller = new AgentController({} as DirectRunService, {} as RedisRunEventBus);
    expect(() => controller.streamEvents('run-1', 'not-a-sequence')).toThrow(BadRequestException);
  });
});

function durableEvent(sequence: number): DurableRunEvent {
  return {
    id: `event-${String(sequence)}`,
    runId: 'run-1',
    sequence,
    eventType: 'run.test',
    eventVersion: 1,
    payload: { sequence },
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
  };
}

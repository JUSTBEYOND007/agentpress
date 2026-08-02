import type {
  DirectRunService,
  DurableRunEvent,
  LiveRunEvent,
  ToolCallService,
} from '@agentpress/agent-application';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AgentController } from '../src/agent/agent.controller.js';
import type { RedisRunEventBus } from '../src/agent/redis-run-event-bus.js';
import type { AuthenticatedUser } from '../src/auth/auth.service.js';

const user: AuthenticatedUser = { id: 'user-1', subject: 'logto-user', displayName: 'User' };

describe('AgentController SSE replay', () => {
  it('loads stable conversation history for the authenticated member', async () => {
    const calls: unknown[] = [];
    const runs = {
      listMessages(...arguments_: unknown[]) {
        calls.push(arguments_);
        return Promise.resolve([{ id: 'message-1', role: 'user', content: '继续写' }]);
      },
    } as unknown as DirectRunService;
    const controller = new AgentController(runs, {} as RedisRunEventBus);

    await expect(controller.listMessages('conversation-1', 'branch-1', user)).resolves.toEqual([
      { id: 'message-1', role: 'user', content: '继续写' },
    ]);
    expect(calls).toEqual([['conversation-1', 'branch-1', 'user-1']]);
  });

  it('requires caller identity and delegates Run creation exactly', async () => {
    const created: unknown[] = [];
    const runs = {
      create(input: unknown) {
        created.push(input);
        return Promise.resolve({ runId: 'run-1', status: 'queued' });
      },
    } as unknown as DirectRunService;
    const controller = new AgentController(runs, {} as RedisRunEventBus);
    await expect(
      controller.createRun(
        'conversation-1',
        'request-1',
        {
          branchId: 'branch-1',
          prompt: '研究 Kafka',
        },
        user,
      ),
    ).resolves.toMatchObject({ status: 'queued' });
    expect(created).toEqual([
      {
        conversationId: 'conversation-1',
        branchId: 'branch-1',
        userId: 'user-1',
        prompt: '研究 Kafka',
        idempotencyKey: 'request-1',
        mentionTargetIds: [],
        attachmentIds: [],
        skills: [],
        contextBindings: [],
      },
    ]);
    await expect(
      controller.createRun('conversation-1', 'request-2', { branchId: 'branch-1' }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

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

  it('delegates an exact Tool Call approval decision', async () => {
    const decisions: unknown[] = [];
    const toolCalls = {
      decideApproval(input: unknown) {
        decisions.push(input);
        return Promise.resolve({ toolCallId: 'call-1', decision: 'approved', status: 'approved' });
      },
    } as unknown as ToolCallService;
    const controller = new AgentController(
      {} as DirectRunService,
      {} as RedisRunEventBus,
      toolCalls,
    );

    await expect(
      controller.decideToolCall('call-1', { decision: 'approved' }, user),
    ).resolves.toMatchObject({ status: 'approved' });
    expect(decisions).toEqual([{ toolCallId: 'call-1', decision: 'approved', userId: 'user-1' }]);
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

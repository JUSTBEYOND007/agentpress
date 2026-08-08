import { describe, expect, it } from 'vitest';

import { projectRunProgress } from '../src/run-progress.js';
import type { DurableRunEvent } from '../src/contracts.js';

describe('Run progress projection', () => {
  it('projects durable phase, completed tasks, outstanding interaction and safe checkpoint', () => {
    const part = projectRunProgress({
      runId: 'run-1',
      mode: 'planned',
      status: 'waiting_for_user',
      events: [
        event(1, 'plan.revised', { tasks: [{ id: 'task-1' }, { id: 'task-2' }] }),
        event(2, 'task.succeeded', {
          taskId: 'task-1',
          attempt: 1,
          objective: '完成资料收集',
        }),
        event(3, 'task.started', {
          taskId: 'task-2',
          attempt: 1,
          objective: '撰写正文',
          owner: 'writer',
        }),
      ],
      pendingInteraction: { type: 'ask-user', id: 'question-1' },
      recoveryPoint: {
        sequence: 7,
        reason: 'task_settled',
        createdAt: new Date('2026-01-01T00:00:03.000Z'),
      },
    });

    expect(part).toMatchObject({
      type: 'progress',
      payload: {
        phase: 'waiting_for_user',
        completedSteps: 1,
        totalSteps: 2,
        activeStep: {
          taskId: 'task-2',
          attempt: 1,
          correlationId: 'task:task-2:attempt:1',
          objective: '撰写正文',
          owner: 'writer',
        },
        outstandingInteraction: 'ask-user',
        recoveryPoint: { sequence: 7, reason: 'task_settled' },
      },
    });
  });

  it('does not add long-task chrome to an ordinary direct chat', () => {
    expect(
      projectRunProgress({
        runId: 'run-1',
        mode: 'direct',
        status: 'completed',
        events: [],
      }),
    ).toBeUndefined();
  });

  it('keeps the highest Task attempt active when an old result arrives late', () => {
    const part = projectRunProgress({
      runId: 'run-1',
      mode: 'planned',
      status: 'running',
      events: [
        event(1, 'plan.revised', { tasks: [{ id: 'task-1' }] }),
        event(2, 'task.started', {
          taskId: 'task-1',
          attempt: 2,
          objective: '当前重试',
          owner: 'writer',
        }),
        event(3, 'task.succeeded', { taskId: 'task-1', attempt: 1 }),
      ],
    });

    expect(part?.payload).toMatchObject({
      completedSteps: 0,
      activeStep: {
        taskId: 'task-1',
        attempt: 2,
        correlationId: 'task:task-1:attempt:2',
        objective: '当前重试',
      },
    });
  });

  it('ignores Task progress facts without complete identity', () => {
    const part = projectRunProgress({
      runId: 'run-1',
      mode: 'planned',
      status: 'running',
      events: [
        event(1, 'plan.revised', { tasks: [{ id: 'task-1' }] }),
        event(2, 'task.succeeded', { taskId: 'task-1' }),
        event(3, 'task.started', { attempt: 1, objective: '无 Task ID' }),
      ],
    });

    expect(part?.payload).toMatchObject({ completedSteps: 0, totalSteps: 1 });
    expect(part?.payload.activeStep).toBeUndefined();
  });
});

function event(
  sequence: number,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): DurableRunEvent {
  return {
    id: `event-${String(sequence)}`,
    runId: 'run-1',
    sequence,
    eventType,
    eventVersion: 1,
    payload,
    createdAt: new Date(`2026-01-01T00:00:0${String(sequence)}.000Z`),
  };
}

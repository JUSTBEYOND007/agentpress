import { describe, expect, it } from 'vitest';

import {
  AgentTaskWaitError,
  projectAgentTaskWaitSnapshot,
  waitForAgentTaskSettlement,
  type AgentTaskResultFact,
  type AgentTaskWaitSnapshot,
} from '../src/agent-task-wait-service.js';

describe('durable Agent Task wait protocol', () => {
  it('returns settled and still-running Tasks in requested order', () => {
    const snapshot = projectAgentTaskWaitSnapshot({
      taskIds: ['task-failed', 'task-running', 'task-succeeded'],
      tasks: [
        { taskId: 'task-succeeded', attempt: 1, status: 'succeeded' },
        { taskId: 'task-running', attempt: 2, status: 'running' },
        { taskId: 'task-failed', attempt: 3, status: 'failed' },
      ],
      results: [
        taskResult('task-succeeded', 1, 'succeeded'),
        taskResult('task-failed', 3, 'failed'),
      ],
    });

    expect(snapshot.settled.map(({ taskId }) => taskId)).toEqual(['task-failed', 'task-succeeded']);
    expect(snapshot.stillRunning).toEqual([
      { taskId: 'task-running', attempt: 2, status: 'running' },
    ]);
  });

  it('fails closed when a terminal Task has no result from the same attempt', () => {
    expect(() =>
      projectAgentTaskWaitSnapshot({
        taskIds: ['task-1'],
        tasks: [{ taskId: 'task-1', attempt: 2, status: 'failed' }],
        results: [taskResult('task-1', 1, 'failed')],
      }),
    ).toThrow(
      expect.objectContaining<Partial<AgentTaskWaitError>>({
        code: 'incomplete_task_settlement',
      }),
    );
  });

  it('waits until the first Task settles and keeps the rest visible', async () => {
    const snapshots: AgentTaskWaitSnapshot[] = [
      {
        settled: [],
        stillRunning: [
          { taskId: 'task-1', attempt: 1, status: 'running' },
          { taskId: 'task-2', attempt: 1, status: 'ready' },
        ],
      },
      {
        settled: [taskResult('task-2', 1, 'failed')],
        stillRunning: [{ taskId: 'task-1', attempt: 1, status: 'running' }],
      },
    ];
    let elapsed = 0;

    await expect(
      waitForAgentTaskSettlement(
        () => {
          const snapshot = snapshots.shift();
          if (!snapshot) throw new Error('Test snapshot sequence was exhausted');
          return Promise.resolve(snapshot);
        },
        { timeoutMs: 1_000, pollIntervalMs: 100 },
        {
          now: () => elapsed,
          sleep: (milliseconds) => {
            elapsed += milliseconds;
            return Promise.resolve();
          },
        },
      ),
    ).resolves.toEqual({
      settled: [taskResult('task-2', 1, 'failed')],
      stillRunning: [{ taskId: 'task-1', attempt: 1, status: 'running' }],
      timedOut: false,
    });
  });

  it('returns a bounded timeout without changing Task state', async () => {
    let elapsed = 0;
    const snapshot: AgentTaskWaitSnapshot = {
      settled: [],
      stillRunning: [{ taskId: 'task-1', attempt: 1, status: 'running' }],
    };

    await expect(
      waitForAgentTaskSettlement(
        () => Promise.resolve(snapshot),
        { timeoutMs: 250 },
        {
          now: () => elapsed,
          sleep: (milliseconds) => {
            elapsed += milliseconds;
            return Promise.resolve();
          },
        },
      ),
    ).resolves.toEqual({ ...snapshot, timedOut: true });
    expect(elapsed).toBe(250);
  });

  it('propagates cancellation before another database read', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    let loads = 0;
    controller.abort(reason);

    await expect(
      waitForAgentTaskSettlement(
        () => {
          loads += 1;
          return Promise.resolve({ settled: [], stillRunning: [] });
        },
        { timeoutMs: 1_000, signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(loads).toBe(0);
  });
});

function taskResult(
  taskId: string,
  attempt: number,
  status: 'succeeded' | 'failed',
): AgentTaskResultFact {
  return {
    taskId,
    attempt,
    status,
    summary: `${taskId} ${status}`,
    artifacts: [],
    evidence: [],
    usage: {},
    warnings: [],
    failure: status === 'failed' ? { code: 'failed', message: 'failed' } : null,
  };
}

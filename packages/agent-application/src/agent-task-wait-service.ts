import { setTimeout as delay } from 'node:timers/promises';

import { agentTasks, taskResults, type AgentPressDatabase } from '@agentpress/database';
import { and, eq, inArray } from 'drizzle-orm';

export type AgentTaskWaitStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_for_approval'
  | 'interrupted'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type AgentTaskWaitFact = {
  readonly taskId: string;
  readonly attempt: number;
  readonly status: AgentTaskWaitStatus;
};

export type AgentTaskResultFact = {
  readonly taskId: string;
  readonly attempt: number;
  readonly status: 'succeeded' | 'failed';
  readonly summary: string;
  readonly artifacts: readonly unknown[];
  readonly evidence: readonly unknown[];
  readonly usage: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
  readonly failure: Readonly<Record<string, unknown>> | null;
};

export type SettledAgentTask =
  | AgentTaskResultFact
  | {
      readonly taskId: string;
      readonly attempt: number;
      readonly status: 'skipped' | 'cancelled';
      readonly artifacts: readonly [];
      readonly evidence: readonly [];
      readonly usage: Readonly<Record<string, never>>;
      readonly warnings: readonly string[];
      readonly failure: Readonly<Record<string, unknown>>;
    };

export type AgentTaskWaitSnapshot = {
  readonly settled: readonly SettledAgentTask[];
  readonly stillRunning: readonly AgentTaskWaitFact[];
};

export type AgentTaskWaitResult = AgentTaskWaitSnapshot & {
  readonly timedOut: boolean;
};

export class AgentTaskWaitError extends Error {
  public constructor(
    public readonly code: 'task_not_found' | 'incomplete_task_settlement',
    message: string,
  ) {
    super(message);
    this.name = 'AgentTaskWaitError';
  }
}

export function projectAgentTaskWaitSnapshot(input: {
  readonly taskIds: readonly string[];
  readonly tasks: readonly AgentTaskWaitFact[];
  readonly results: readonly AgentTaskResultFact[];
}): AgentTaskWaitSnapshot {
  const tasksById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const latestResults = new Map<string, AgentTaskResultFact>();
  for (const result of input.results) {
    const current = latestResults.get(result.taskId);
    if (!current || result.attempt > current.attempt) latestResults.set(result.taskId, result);
  }
  const settled: SettledAgentTask[] = [];
  const stillRunning: AgentTaskWaitFact[] = [];
  for (const taskId of input.taskIds) {
    const task = tasksById.get(taskId);
    if (!task) {
      throw new AgentTaskWaitError(
        'task_not_found',
        `Agent Task ${taskId} was not found in the Run`,
      );
    }
    if (task.status === 'succeeded' || task.status === 'failed') {
      const result = latestResults.get(taskId);
      if (result?.attempt !== task.attempt || result.status !== task.status) {
        throw new AgentTaskWaitError(
          'incomplete_task_settlement',
          `Agent Task ${taskId} has no matching TaskResult for attempt ${String(task.attempt)}`,
        );
      }
      settled.push(result);
      continue;
    }
    if (task.status === 'skipped' || task.status === 'cancelled') {
      settled.push({
        taskId,
        attempt: task.attempt,
        status: task.status,
        artifacts: [],
        evidence: [],
        usage: {},
        warnings: [],
        failure: { code: `task_${task.status}`, message: `Agent Task ${task.status}` },
      });
      continue;
    }
    stillRunning.push(task);
  }
  return { settled, stillRunning };
}

export async function waitForAgentTaskSettlement(
  load: () => Promise<AgentTaskWaitSnapshot>,
  input: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly pollIntervalMs?: number;
  },
  controls: {
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<AgentTaskWaitResult> {
  validateWaitDuration('timeout', input.timeoutMs, 0, 3_600_000);
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  validateWaitDuration('poll interval', pollIntervalMs, 25, 5_000);
  const now = controls.now ?? Date.now;
  const sleep = controls.sleep ?? abortableDelay;
  const deadline = now() + input.timeoutMs;
  for (;;) {
    throwIfAborted(input.signal);
    const snapshot = await load();
    if (snapshot.settled.length > 0) return { ...snapshot, timedOut: false };
    const remaining = deadline - now();
    if (remaining <= 0) return { ...snapshot, timedOut: true };
    await sleep(Math.min(pollIntervalMs, remaining), input.signal);
  }
}

export class AgentTaskWaitService {
  public constructor(private readonly database: AgentPressDatabase) {}

  public async waitForAny(input: {
    readonly runId: string;
    readonly taskIds: readonly string[];
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly pollIntervalMs?: number;
  }): Promise<AgentTaskWaitResult> {
    if (input.taskIds.length === 0 || input.taskIds.length > 64) {
      throw new RangeError('Agent Task wait requires between 1 and 64 Task IDs');
    }
    if (new Set(input.taskIds).size !== input.taskIds.length) {
      throw new TypeError('Agent Task wait IDs must be unique');
    }
    return waitForAgentTaskSettlement(() => this.loadSnapshot(input.runId, input.taskIds), input);
  }

  private async loadSnapshot(
    runId: string,
    taskIds: readonly string[],
  ): Promise<AgentTaskWaitSnapshot> {
    const [tasks, results] = await Promise.all([
      this.database
        .select({
          taskId: agentTasks.id,
          attempt: agentTasks.attempt,
          status: agentTasks.status,
        })
        .from(agentTasks)
        .where(and(eq(agentTasks.runId, runId), inArray(agentTasks.id, taskIds))),
      this.database
        .select({
          taskId: taskResults.taskId,
          attempt: taskResults.attempt,
          status: taskResults.status,
          summary: taskResults.summary,
          artifacts: taskResults.artifacts,
          evidence: taskResults.evidence,
          usage: taskResults.usage,
          warnings: taskResults.warnings,
          failure: taskResults.failure,
        })
        .from(taskResults)
        .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
        .where(and(eq(agentTasks.runId, runId), inArray(taskResults.taskId, taskIds))),
    ]);
    return projectAgentTaskWaitSnapshot({
      taskIds,
      tasks,
      results: results.filter(isAgentTaskResultFact),
    });
  }
}

function isAgentTaskResultFact(value: {
  readonly taskId: string;
  readonly attempt: number;
  readonly status: string;
  readonly summary: string;
  readonly artifacts: readonly unknown[];
  readonly evidence: readonly unknown[];
  readonly usage: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
  readonly failure: Readonly<Record<string, unknown>> | null;
}): value is AgentTaskResultFact {
  return value.status === 'succeeded' || value.status === 'failed';
}

function validateWaitDuration(
  label: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `Agent Task wait ${label} must be between ${String(minimum)} and ${String(maximum)} ms`,
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Agent Task wait was aborted', { cause: signal.reason });
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, signal ? { signal } : undefined);
}

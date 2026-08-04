import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { AgentPressDatabase, DatabaseTransaction } from './postgres.js';
import { agentTaskLeases, agentTasks, taskResults } from './schema.js';

export type TaskLease = {
  readonly leaseId: string;
  readonly leaseToken: string;
  readonly taskId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly workerId: string;
  readonly expiresAt: Date;
};

export type TaskClaim = {
  readonly taskId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly lease: TaskLease;
};

/**
 * Commits one worker attempt only while that exact attempt still owns the
 * running Task state. Recovery, retry, and cancellation therefore fence stale workers.
 */
export async function settleAgentTaskAttempt(
  transaction: DatabaseTransaction,
  input: {
    readonly taskId: string;
    readonly attempt: number;
    readonly status: 'succeeded' | 'failed' | 'cancelled' | 'skipped';
    readonly now?: Date;
  },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new RangeError('Task settlement attempt must be a positive integer');
  }
  const now = input.now ?? new Date();
  const rows = await transaction
    .update(agentTasks)
    .set({
      status: input.status,
      completedAt: now,
      updatedAt: now,
      version: sql`${agentTasks.version} + 1`,
    })
    .where(
      and(
        eq(agentTasks.id, input.taskId),
        eq(agentTasks.status, 'running'),
        eq(agentTasks.attempt, input.attempt),
      ),
    )
    .returning({ id: agentTasks.id });
  return rows.length === 1;
}

/**
 * Atomically claims a pending/recoverable task and creates its durable lease.
 * A successful TaskResult is checked in the same transaction so replayed
 * commands cannot start a settled task again.
 */
export async function claimAgentTask(
  transaction: DatabaseTransaction,
  input: {
    readonly taskId: string;
    readonly workerId: string;
    readonly leaseId: string;
    readonly leaseToken: string;
    readonly leaseMs: number;
    readonly now?: Date;
  },
): Promise<TaskClaim | undefined> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
    throw new RangeError('Task lease duration must be a positive integer');
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.leaseMs);
  const rows = await transaction
    .update(agentTasks)
    .set({
      status: 'running',
      attempt: sql`${agentTasks.attempt} + 1`,
      updatedAt: now,
      version: sql`${agentTasks.version} + 1`,
    })
    .where(
      and(
        eq(agentTasks.id, input.taskId),
        inArray(agentTasks.status, ['pending', 'ready', 'interrupted']),
        sql`${agentTasks.attempt} < ${agentTasks.maxAttempts}`,
        sql`not exists (
          select 1 from ${taskResults}
          where ${taskResults.taskId} = ${agentTasks.id}
            and ${taskResults.status} = 'succeeded'
        )`,
        sql`not exists (
          select 1 from ${agentTaskLeases}
          where ${agentTaskLeases.taskId} = ${agentTasks.id}
            and ${agentTaskLeases.releasedAt} is null
            and ${agentTaskLeases.expiresAt} > ${now}
        )`,
      ),
    )
    .returning({ taskId: agentTasks.id, runId: agentTasks.runId, attempt: agentTasks.attempt });
  const row = rows[0];
  if (!row) return undefined;

  await transaction.insert(agentTaskLeases).values({
    id: input.leaseId,
    taskId: row.taskId,
    runId: row.runId,
    attempt: row.attempt,
    leaseToken: input.leaseToken,
    workerId: input.workerId,
    acquiredAt: now,
    expiresAt,
  });
  return {
    ...row,
    lease: {
      leaseId: input.leaseId,
      leaseToken: input.leaseToken,
      taskId: row.taskId,
      runId: row.runId,
      attempt: row.attempt,
      workerId: input.workerId,
      expiresAt,
    },
  };
}

export async function renewAgentTaskLease(
  db: AgentPressDatabase,
  input: {
    readonly leaseToken: string;
    readonly workerId: string;
    readonly leaseMs: number;
    readonly now?: Date;
  },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
    throw new RangeError('Task lease duration must be a positive integer');
  }
  const now = input.now ?? new Date();
  const result = await db
    .update(agentTaskLeases)
    .set({ expiresAt: new Date(now.getTime() + input.leaseMs) })
    .where(
      and(
        eq(agentTaskLeases.leaseToken, input.leaseToken),
        eq(agentTaskLeases.workerId, input.workerId),
        isNull(agentTaskLeases.releasedAt),
        sql`${agentTaskLeases.expiresAt} > ${now}`,
      ),
    );
  return (result.rowCount ?? 0) === 1;
}

export async function releaseAgentTaskLease(
  db: AgentPressDatabase,
  input: { readonly leaseToken: string; readonly workerId: string; readonly now?: Date },
): Promise<boolean> {
  const result = await db
    .update(agentTaskLeases)
    .set({ releasedAt: input.now ?? new Date() })
    .where(
      and(
        eq(agentTaskLeases.leaseToken, input.leaseToken),
        eq(agentTaskLeases.workerId, input.workerId),
        isNull(agentTaskLeases.releasedAt),
      ),
    );
  return (result.rowCount ?? 0) === 1;
}

/** Marks orphaned running tasks recoverable without changing a settled result. */
export async function reclaimExpiredAgentTasks(
  db: AgentPressDatabase,
  now = new Date(),
): Promise<readonly string[]> {
  const rows = await db
    .update(agentTasks)
    .set({ status: 'interrupted', updatedAt: now, version: sql`${agentTasks.version} + 1` })
    .where(
      and(
        eq(agentTasks.status, 'running'),
        sql`not exists (
          select 1 from ${agentTaskLeases}
          where ${agentTaskLeases.taskId} = ${agentTasks.id}
            and ${agentTaskLeases.releasedAt} is null
            and ${agentTaskLeases.expiresAt} > ${now}
        )`,
        sql`not exists (
          select 1 from ${taskResults}
          where ${taskResults.taskId} = ${agentTasks.id}
            and ${taskResults.status} = 'succeeded'
        )`,
      ),
    )
    .returning({ id: agentTasks.id });
  return rows.map(({ id }) => id);
}

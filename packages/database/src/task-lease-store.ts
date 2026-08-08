// Stale-owner behavior adapted from Oh My Pi v17.1.8, commit f446b8a (MIT).
// Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Boluk.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { AgentPressDatabase, DatabaseTransaction } from './postgres.js';
import { enqueueOutboxMessage } from './outbox.js';
import { forfeitActiveTaskBudgets } from './run-specialist-budget-store.js';
import { appendRunEvent } from './run-event-store.js';
import {
  agentTaskLeases,
  agentTasks,
  runEvents,
  taskResultInvalidations,
  taskResults,
} from './schema.js';

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
  readonly planRevisionId: string;
  readonly attempt: number;
  readonly lease: TaskLease;
};

/** Cancels every non-terminal Task in a Run and fences its active worker leases. */
export async function cancelAgentRunTasks(
  transaction: DatabaseTransaction,
  input: { readonly runId: string; readonly now?: Date },
): Promise<readonly { readonly taskId: string; readonly attempt: number }[]> {
  const now = input.now ?? new Date();
  const cancelled = await transaction
    .update(agentTasks)
    .set({
      status: 'cancelled',
      completedAt: now,
      updatedAt: now,
      version: sql`${agentTasks.version} + 1`,
    })
    .where(
      and(
        eq(agentTasks.runId, input.runId),
        inArray(agentTasks.status, [
          'pending',
          'ready',
          'running',
          'waiting_for_approval',
          'interrupted',
        ]),
      ),
    )
    .returning({ taskId: agentTasks.id, attempt: agentTasks.attempt });
  if (cancelled.length > 0) {
    await transaction
      .update(agentTaskLeases)
      .set({ releasedAt: now })
      .where(
        and(
          eq(agentTaskLeases.runId, input.runId),
          inArray(
            agentTaskLeases.taskId,
            cancelled.map(({ taskId }) => taskId),
          ),
          isNull(agentTaskLeases.releasedAt),
        ),
      );
    await forfeitActiveTaskBudgets(transaction, {
      taskIds: cancelled.map(({ taskId }) => taskId),
      now,
    });
  }
  return cancelled;
}

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
            and not exists (
              select 1 from ${taskResultInvalidations}
              where ${taskResultInvalidations.taskResultId} = ${taskResults.id}
            )
        )`,
        sql`not exists (
          select 1 from ${agentTaskLeases}
          where ${agentTaskLeases.taskId} = ${agentTasks.id}
            and ${agentTaskLeases.releasedAt} is null
            and ${agentTaskLeases.expiresAt} > ${now}
        )`,
      ),
    )
    .returning({
      taskId: agentTasks.id,
      runId: agentTasks.runId,
      planRevisionId: agentTasks.planRevisionId,
      attempt: agentTasks.attempt,
    });
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
  const rows = await reclaimExpiredAgentTaskRows(db, now);
  return rows.map(({ taskId }) => taskId);
}

/** Atomically makes expired Tasks claimable and emits a fresh durable execution command. */
export async function requeueExpiredAgentTasks(
  transaction: DatabaseTransaction,
  input: {
    readonly topic: string;
    readonly createId: () => string;
    readonly now?: Date;
    readonly collectEvent?: (event: typeof runEvents.$inferSelect) => void;
  },
): Promise<
  readonly {
    readonly taskId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly owner: string;
  }[]
> {
  const now = input.now ?? new Date();
  const rows = await reclaimExpiredAgentTaskRows(transaction, now);
  for (const row of rows) {
    const event = await appendRunEvent(transaction, {
      id: input.createId(),
      runId: row.runId,
      eventType: 'task.interrupted',
      payload: {
        taskId: row.taskId,
        owner: row.owner,
        attempt: row.attempt,
        reason: 'lease_expired',
        recoveryScheduled: true,
      },
    });
    input.collectEvent?.(event);
    const messageId = input.createId();
    await enqueueOutboxMessage(transaction, {
      id: messageId,
      aggregateType: 'AgentTask',
      aggregateId: row.taskId,
      topic: input.topic,
      messageKey: `${row.runId}:${row.taskId}`,
      payload: {
        command: 'task.execute',
        messageId,
        runId: row.runId,
        taskId: row.taskId,
      },
      occurredAt: now,
    });
  }
  return rows;
}

async function reclaimExpiredAgentTaskRows(
  db: AgentPressDatabase | DatabaseTransaction,
  now: Date,
): Promise<
  readonly {
    readonly taskId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly owner: string;
  }[]
> {
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
    .returning({
      taskId: agentTasks.id,
      runId: agentTasks.runId,
      attempt: agentTasks.attempt,
      owner: agentTasks.owner,
    });
  if (rows.length > 0) {
    await forfeitActiveTaskBudgets(db, { taskIds: rows.map(({ taskId }) => taskId), now });
  }
  return rows;
}

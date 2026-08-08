import { and, eq, inArray, sql } from 'drizzle-orm';

import type { AgentPressDatabase, DatabaseTransaction } from './postgres.js';
import { runSpecialistBudgets, taskBudgetReservations } from './schema.js';

export type TaskBudgetReservationResult =
  | { readonly kind: 'reserved'; readonly reservationId: string }
  | { readonly kind: 'duplicate'; readonly status: 'active' | 'settled' | 'forfeited' }
  | { readonly kind: 'exhausted' };

export async function initializeRunSpecialistBudget(
  transaction: DatabaseTransaction,
  input: { readonly runId: string; readonly maxTokens: number },
): Promise<void> {
  assertPositiveTokens(input.maxTokens, 'Run Specialist token budget');
  await transaction
    .insert(runSpecialistBudgets)
    .values({ runId: input.runId, maxTokens: input.maxTokens })
    .onConflictDoNothing();
  const existing = await transaction
    .select({ maxTokens: runSpecialistBudgets.maxTokens })
    .from(runSpecialistBudgets)
    .where(eq(runSpecialistBudgets.runId, input.runId))
    .limit(1);
  if (existing[0]?.maxTokens !== input.maxTokens) {
    throw new Error('Run Specialist token budget is immutable');
  }
}

export async function reserveTaskBudget(
  transaction: DatabaseTransaction,
  input: {
    readonly reservationId: string;
    readonly runId: string;
    readonly planRevisionId: string;
    readonly taskId: string;
    readonly attempt: number;
    readonly tokens: number;
  },
): Promise<TaskBudgetReservationResult> {
  assertAttempt(input.attempt);
  assertPositiveTokens(input.tokens, 'Task token reservation');
  const inserted = await transaction
    .insert(taskBudgetReservations)
    .values({
      id: input.reservationId,
      runId: input.runId,
      planRevisionId: input.planRevisionId,
      taskId: input.taskId,
      attempt: input.attempt,
      reservedTokens: input.tokens,
      status: 'active',
    })
    .onConflictDoNothing()
    .returning({ id: taskBudgetReservations.id });
  if (inserted.length === 0) {
    const existing = await transaction
      .select({
        runId: taskBudgetReservations.runId,
        planRevisionId: taskBudgetReservations.planRevisionId,
        reservedTokens: taskBudgetReservations.reservedTokens,
        status: taskBudgetReservations.status,
      })
      .from(taskBudgetReservations)
      .where(
        and(
          eq(taskBudgetReservations.taskId, input.taskId),
          eq(taskBudgetReservations.attempt, input.attempt),
        ),
      )
      .limit(1);
    const row = existing.at(0);
    const status = row?.status;
    if (
      row?.runId !== input.runId ||
      row.planRevisionId !== input.planRevisionId ||
      row.reservedTokens !== input.tokens ||
      !isReservationStatus(status)
    ) {
      throw new Error('Task budget reservation identity mismatch');
    }
    return { kind: 'duplicate', status };
  }
  const budget = await transaction
    .update(runSpecialistBudgets)
    .set({
      reservedTokens: sql`${runSpecialistBudgets.reservedTokens} + ${input.tokens}`,
      updatedAt: new Date(),
      version: sql`${runSpecialistBudgets.version} + 1`,
    })
    .where(
      and(
        eq(runSpecialistBudgets.runId, input.runId),
        sql`${runSpecialistBudgets.consumedTokens} + ${runSpecialistBudgets.reservedTokens} + ${input.tokens} <= ${runSpecialistBudgets.maxTokens}`,
      ),
    )
    .returning({ runId: runSpecialistBudgets.runId });
  if (budget.length === 1) return { kind: 'reserved', reservationId: input.reservationId };
  await transaction
    .delete(taskBudgetReservations)
    .where(eq(taskBudgetReservations.id, input.reservationId));
  return { kind: 'exhausted' };
}

export async function settleTaskBudget(
  transaction: DatabaseTransaction,
  input: {
    readonly taskId: string;
    readonly attempt: number;
    readonly actualTokens: number;
    readonly now?: Date;
  },
): Promise<boolean> {
  assertAttempt(input.attempt);
  assertNonNegativeTokens(input.actualTokens, 'Task actual token usage');
  const settled = await transaction
    .update(taskBudgetReservations)
    .set({
      status: 'settled',
      actualTokens: input.actualTokens,
      settledAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(taskBudgetReservations.taskId, input.taskId),
        eq(taskBudgetReservations.attempt, input.attempt),
        eq(taskBudgetReservations.status, 'active'),
      ),
    )
    .returning({
      runId: taskBudgetReservations.runId,
      reservedTokens: taskBudgetReservations.reservedTokens,
    });
  const reservation = settled[0];
  if (!reservation) return false;
  await transaction
    .update(runSpecialistBudgets)
    .set({
      reservedTokens: sql`${runSpecialistBudgets.reservedTokens} - ${reservation.reservedTokens}`,
      consumedTokens: sql`${runSpecialistBudgets.consumedTokens} + ${input.actualTokens}`,
      updatedAt: input.now ?? new Date(),
      version: sql`${runSpecialistBudgets.version} + 1`,
    })
    .where(eq(runSpecialistBudgets.runId, reservation.runId));
  return true;
}

export async function forfeitActiveTaskBudgets(
  transaction: AgentPressDatabase | DatabaseTransaction,
  input: { readonly taskIds: readonly string[]; readonly now?: Date },
): Promise<number> {
  if (input.taskIds.length === 0) return 0;
  const now = input.now ?? new Date();
  const forfeited = await transaction
    .update(taskBudgetReservations)
    .set({
      status: 'forfeited',
      actualTokens: sql`${taskBudgetReservations.reservedTokens}`,
      settledAt: now,
    })
    .where(
      and(
        inArray(taskBudgetReservations.taskId, input.taskIds),
        eq(taskBudgetReservations.status, 'active'),
      ),
    )
    .returning({
      runId: taskBudgetReservations.runId,
      reservedTokens: taskBudgetReservations.reservedTokens,
    });
  const byRun = new Map<string, number>();
  for (const row of forfeited) {
    byRun.set(row.runId, (byRun.get(row.runId) ?? 0) + row.reservedTokens);
  }
  for (const [runId, tokens] of byRun) {
    await transaction
      .update(runSpecialistBudgets)
      .set({
        reservedTokens: sql`${runSpecialistBudgets.reservedTokens} - ${tokens}`,
        consumedTokens: sql`${runSpecialistBudgets.consumedTokens} + ${tokens}`,
        updatedAt: now,
        version: sql`${runSpecialistBudgets.version} + 1`,
      })
      .where(eq(runSpecialistBudgets.runId, runId));
  }
  return forfeited.length;
}

function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError('Task budget attempt must be a positive integer');
  }
}

function assertPositiveTokens(tokens: number, label: string): void {
  if (!Number.isSafeInteger(tokens) || tokens < 1)
    throw new RangeError(`${label} must be positive`);
}

function assertNonNegativeTokens(tokens: number, label: string): void {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError(`${label} must be non-negative`);
  }
}

function isReservationStatus(value: unknown): value is 'active' | 'settled' | 'forfeited' {
  return value === 'active' || value === 'settled' || value === 'forfeited';
}

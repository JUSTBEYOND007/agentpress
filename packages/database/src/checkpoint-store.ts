import { eq, max, sql } from 'drizzle-orm';

import type { DatabaseTransaction } from './postgres.js';
import { agentRuns, checkpoints } from './schema.js';

export type AppendCheckpoint = {
  readonly id: string;
  readonly runId: string;
  readonly reason: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly continuationCursor?: string;
};

export async function appendCheckpoint(
  transaction: DatabaseTransaction,
  checkpoint: AppendCheckpoint,
): Promise<typeof checkpoints.$inferSelect> {
  await transaction.execute(
    sql`select id from ${agentRuns} where id = ${checkpoint.runId} for update`,
  );
  const rows = await transaction
    .select({ sequence: max(checkpoints.sequence) })
    .from(checkpoints)
    .where(eq(checkpoints.runId, checkpoint.runId));
  const inserted = await transaction
    .insert(checkpoints)
    .values({
      id: checkpoint.id,
      runId: checkpoint.runId,
      sequence: (rows[0]?.sequence ?? 0) + 1,
      reason: checkpoint.reason,
      state: checkpoint.state,
      ...(checkpoint.continuationCursor
        ? { continuationCursor: checkpoint.continuationCursor }
        : {}),
    })
    .returning();
  const persisted = inserted[0];
  if (!persisted) {
    throw new Error(`Checkpoint ${checkpoint.id} was not persisted`);
  }
  return persisted;
}

import { eq, sql } from 'drizzle-orm';

import type { DatabaseTransaction } from './postgres.js';
import { agentRuns, runEvents } from './schema.js';

export type AppendRunEvent = {
  readonly id: string;
  readonly runId: string;
  readonly eventType: string;
  readonly eventVersion?: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly visibleToUser?: boolean;
};

export async function appendRunEvent(
  transaction: DatabaseTransaction,
  event: AppendRunEvent,
): Promise<typeof runEvents.$inferSelect> {
  const allocated = await transaction
    .update(agentRuns)
    .set({ nextEventSequence: sql`${agentRuns.nextEventSequence} + 1` })
    .where(eq(agentRuns.id, event.runId))
    .returning({
      sequence: sql<number>`${agentRuns.nextEventSequence} - 1`,
    });
  const sequence = allocated[0]?.sequence;

  if (sequence === undefined) {
    throw new Error(`Agent Run ${event.runId} does not exist`);
  }

  const inserted = await transaction
    .insert(runEvents)
    .values({
      id: event.id,
      runId: event.runId,
      sequence,
      eventType: event.eventType,
      eventVersion: event.eventVersion ?? 1,
      payload: event.payload,
      visibleToUser: event.visibleToUser ?? true,
    })
    .returning();
  const persisted = inserted[0];

  if (!persisted) {
    throw new Error(`Run Event ${event.id} was not persisted`);
  }

  return persisted;
}

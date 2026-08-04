import { and, desc, eq } from 'drizzle-orm';
import type { AgentPressDatabase, DatabaseTransaction } from './postgres.js';
import { memoryCandidates } from './schema.js';

export type ProposeMemoryInput = {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly sourceRunId?: string;
  readonly sourceToolCallId?: string;
  readonly subject: string;
  readonly value: string;
  readonly valueHash: string;
  readonly confidenceBps: number;
  readonly supersedesId?: string;
};

export async function proposeMemoryCandidate(
  database: AgentPressDatabase,
  input: ProposeMemoryInput,
): Promise<typeof memoryCandidates.$inferSelect> {
  const inserted = await database
    .insert(memoryCandidates)
    .values(input)
    .onConflictDoNothing()
    .returning();
  const created = inserted[0];
  if (created) return created;
  const existing = await database
    .select()
    .from(memoryCandidates)
    .where(
      and(
        eq(memoryCandidates.workspaceId, input.workspaceId),
        eq(memoryCandidates.userId, input.userId),
        eq(memoryCandidates.subject, input.subject),
        eq(memoryCandidates.valueHash, input.valueHash),
      ),
    )
    .limit(1);
  const candidate = existing[0];
  if (!candidate) throw new Error('Memory candidate conflict could not be resolved');
  return candidate;
}

export async function decideMemoryCandidate(
  database: AgentPressDatabase,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly userId: string;
    readonly decision: 'accepted' | 'rejected';
    readonly decidedAt?: Date;
  },
): Promise<typeof memoryCandidates.$inferSelect | undefined> {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(memoryCandidates)
      .where(
        and(
          eq(memoryCandidates.id, input.id),
          eq(memoryCandidates.workspaceId, input.workspaceId),
          eq(memoryCandidates.userId, input.userId),
          eq(memoryCandidates.status, 'pending'),
        ),
      )
      .for('update')
      .limit(1);
    const candidate = rows[0];
    if (!candidate) return undefined;
    if (input.decision === 'accepted' && candidate.supersedesId)
      await supersedeMemory(transaction, candidate.supersedesId, input.workspaceId, input.userId);
    const updated = await transaction
      .update(memoryCandidates)
      .set({
        status: input.decision,
        decidedAt: input.decidedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(memoryCandidates.id, input.id))
      .returning();
    return updated[0];
  });
}

export function listAcceptedMemory(
  database: AgentPressDatabase,
  input: { readonly workspaceId: string; readonly userId: string; readonly limit?: number },
): Promise<(typeof memoryCandidates.$inferSelect)[]> {
  return database
    .select()
    .from(memoryCandidates)
    .where(
      and(
        eq(memoryCandidates.workspaceId, input.workspaceId),
        eq(memoryCandidates.userId, input.userId),
        eq(memoryCandidates.status, 'accepted'),
      ),
    )
    .orderBy(desc(memoryCandidates.updatedAt))
    .limit(input.limit ?? 50);
}

async function supersedeMemory(
  transaction: DatabaseTransaction,
  id: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await transaction
    .update(memoryCandidates)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(
      and(
        eq(memoryCandidates.id, id),
        eq(memoryCandidates.workspaceId, workspaceId),
        eq(memoryCandidates.userId, userId),
        eq(memoryCandidates.status, 'accepted'),
      ),
    );
}

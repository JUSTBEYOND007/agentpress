import { createHash } from 'node:crypto';

import { and, desc, eq, gt, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { AgentPressDatabase, DatabaseTransaction } from './postgres.js';
import { memoryCandidates } from './schema.js';

export type MemoryCandidateKind =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'commitment'
  | 'goal'
  | 'event'
  | 'instruction'
  | 'learning'
  | 'error'
  | 'artifact';

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
  readonly kind?: MemoryCandidateKind;
  readonly importanceBps?: number;
  readonly validFrom?: Date;
  readonly validUntil?: Date;
  readonly sourceEvidenceIds?: readonly string[];
  readonly sourceMemoryIds?: readonly string[];
  readonly supersedesId?: string;
};

export async function proposeMemoryCandidate(
  database: AgentPressDatabase | DatabaseTransaction,
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
    if (input.decision === 'accepted') {
      const supersededIds = [
        ...(candidate.supersedesId ? [candidate.supersedesId] : []),
        ...candidate.sourceMemoryIds,
      ].filter((id, index, ids) => id !== candidate.id && ids.indexOf(id) === index);
      if (supersededIds.length > 0)
        await supersedeMemory(transaction, supersededIds, input.workspaceId, input.userId);
    }
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
  input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly limit?: number;
    readonly now?: Date;
  },
): Promise<(typeof memoryCandidates.$inferSelect)[]> {
  const now = input.now ?? new Date();
  return database
    .select()
    .from(memoryCandidates)
    .where(
      and(
        eq(memoryCandidates.workspaceId, input.workspaceId),
        eq(memoryCandidates.userId, input.userId),
        eq(memoryCandidates.status, 'accepted'),
        or(lte(memoryCandidates.validFrom, now), isNull(memoryCandidates.validFrom)),
        or(gt(memoryCandidates.validUntil, now), isNull(memoryCandidates.validUntil)),
      ),
    )
    .orderBy(desc(memoryCandidates.updatedAt))
    .limit(input.limit ?? 50);
}

export async function deleteMemoryCandidate(
  database: AgentPressDatabase,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly userId: string;
    readonly deletedAt?: Date;
  },
): Promise<typeof memoryCandidates.$inferSelect | undefined> {
  const deletedAt = input.deletedAt ?? new Date();
  const tombstone = createHash('sha256').update(`deleted:${input.id}`).digest('hex');
  const rows = await database
    .update(memoryCandidates)
    .set({
      subject: `deleted:${input.id}`,
      value: '[deleted]',
      valueHash: tombstone,
      confidenceBps: 0,
      importanceBps: 0,
      validFrom: null,
      validUntil: null,
      sourceRunId: null,
      sourceToolCallId: null,
      sourceEvidenceIds: [],
      sourceMemoryIds: [],
      supersedesId: null,
      status: 'deleted',
      decidedAt: deletedAt,
      updatedAt: deletedAt,
    })
    .where(
      and(
        eq(memoryCandidates.id, input.id),
        eq(memoryCandidates.workspaceId, input.workspaceId),
        eq(memoryCandidates.userId, input.userId),
        ne(memoryCandidates.status, 'deleted'),
      ),
    )
    .returning();
  return rows[0];
}

export function exportMemoryCandidates(
  database: AgentPressDatabase,
  input: { readonly workspaceId: string; readonly userId: string },
): Promise<(typeof memoryCandidates.$inferSelect)[]> {
  return database
    .select()
    .from(memoryCandidates)
    .where(
      and(
        eq(memoryCandidates.workspaceId, input.workspaceId),
        eq(memoryCandidates.userId, input.userId),
        ne(memoryCandidates.status, 'deleted'),
      ),
    )
    .orderBy(desc(memoryCandidates.createdAt));
}

async function supersedeMemory(
  transaction: DatabaseTransaction,
  ids: readonly string[],
  workspaceId: string,
  userId: string,
): Promise<void> {
  await transaction
    .update(memoryCandidates)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(
      and(
        inArray(memoryCandidates.id, ids),
        eq(memoryCandidates.workspaceId, workspaceId),
        eq(memoryCandidates.userId, userId),
        eq(memoryCandidates.status, 'accepted'),
      ),
    );
}

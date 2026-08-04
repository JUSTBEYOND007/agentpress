import { and, desc, eq, max } from 'drizzle-orm';

import type { AgentPressDatabase } from './postgres.js';
import { agentSessionCompactions, agentSessions, agentTranscriptEntries } from './schema.js';

export type AgentSessionCompactionReason = 'mid_turn' | 'overflow';
export type AgentSessionCompactionReserveProvenance = 'default' | 'explicit' | 'proportional';

type AgentSessionCompactionBase = {
  readonly id: string;
  readonly sessionId: string;
  readonly reason: AgentSessionCompactionReason;
  readonly sourceFromSequence: number;
  readonly sourceThroughSequence: number;
  readonly tokensBefore: number;
  readonly model: string;
  readonly promptVersion: string;
  readonly reserveTokens: number;
  readonly reserveProvenance: AgentSessionCompactionReserveProvenance;
  readonly preserveData: Readonly<Record<string, unknown>>;
};

export type AppendAgentSessionCompactionInput = AgentSessionCompactionBase &
  (
    | {
        readonly firstKeptSequence: number;
        readonly summary: string;
        readonly tokenCount: number;
        readonly failure?: never;
      }
    | {
        readonly firstKeptSequence?: never;
        readonly summary?: never;
        readonly tokenCount?: never;
        readonly failure: {
          readonly code: string;
          readonly message: string;
          readonly retryable: boolean;
          readonly details?: Readonly<Record<string, unknown>>;
        };
      }
  );

export async function appendAgentSessionCompaction(
  database: AgentPressDatabase,
  input: AppendAgentSessionCompactionInput,
): Promise<typeof agentSessionCompactions.$inferSelect> {
  return database.transaction(async (transaction) => {
    const sessions = await transaction
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.id, input.sessionId))
      .for('update')
      .limit(1);
    if (!sessions[0]) throw new Error(`Agent Session ${input.sessionId} does not exist`);
    validateRange(input.sourceFromSequence, input.sourceThroughSequence);

    const [sourceFrom, sourceThrough] = await Promise.all([
      getTranscriptEntry(transaction, input.sessionId, input.sourceFromSequence),
      getTranscriptEntry(transaction, input.sessionId, input.sourceThroughSequence),
    ]);
    if (!sourceFrom || !sourceThrough) {
      throw new Error('Agent Session compaction source range must reference persisted transcript');
    }

    const [versions, previousRows] = await Promise.all([
      transaction
        .select({ version: max(agentSessionCompactions.version) })
        .from(agentSessionCompactions)
        .where(eq(agentSessionCompactions.sessionId, input.sessionId)),
      transaction
        .select()
        .from(agentSessionCompactions)
        .where(
          and(
            eq(agentSessionCompactions.sessionId, input.sessionId),
            eq(agentSessionCompactions.status, 'completed'),
          ),
        )
        .orderBy(desc(agentSessionCompactions.version))
        .limit(1),
    ]);
    const previous = previousRows[0];
    if (previous && input.sourceFromSequence !== previous.firstKeptSequence) {
      throw new Error('Incremental Agent Session compaction must continue from the keep boundary');
    }
    const version = (versions[0]?.version ?? 0) + 1;

    if (input.failure === undefined) {
      const summary = input.summary.trim();
      if (!summary) throw new Error('Agent Session compaction summary is empty');
      if (
        !Number.isSafeInteger(input.firstKeptSequence) ||
        input.firstKeptSequence <= input.sourceThroughSequence
      ) {
        throw new Error('Agent Session compaction keep boundary is invalid');
      }
      const firstKept = await getTranscriptEntry(
        transaction,
        input.sessionId,
        input.firstKeptSequence,
      );
      if (!firstKept) {
        throw new Error(
          'Agent Session compaction keep boundary must reference persisted transcript',
        );
      }
      const rows = await transaction
        .insert(agentSessionCompactions)
        .values({
          ...input,
          summary,
          status: 'completed',
          version,
          previousCompactionId: previous?.id,
          sourceFromEntryId: sourceFrom.id,
          sourceThroughEntryId: sourceThrough.id,
          firstKeptEntryId: firstKept.id,
        })
        .returning();
      const persisted = rows[0];
      if (!persisted) throw new Error(`Agent Session compaction ${input.id} was not persisted`);
      return persisted;
    }

    const rows = await transaction
      .insert(agentSessionCompactions)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        reason: input.reason,
        sourceFromSequence: input.sourceFromSequence,
        sourceThroughSequence: input.sourceThroughSequence,
        tokensBefore: input.tokensBefore,
        model: input.model,
        promptVersion: input.promptVersion,
        reserveTokens: input.reserveTokens,
        reserveProvenance: input.reserveProvenance,
        preserveData: input.preserveData,
        failure: input.failure,
        status: 'failed',
        version,
        previousCompactionId: previous?.id,
        sourceFromEntryId: sourceFrom.id,
        sourceThroughEntryId: sourceThrough.id,
      })
      .returning();
    const persisted = rows[0];
    if (!persisted) throw new Error(`Agent Session compaction ${input.id} was not persisted`);
    return persisted;
  });
}

export async function getEffectiveAgentSessionCompaction(
  database: AgentPressDatabase,
  sessionId: string,
): Promise<typeof agentSessionCompactions.$inferSelect | undefined> {
  const rows = await database
    .select()
    .from(agentSessionCompactions)
    .where(
      and(
        eq(agentSessionCompactions.sessionId, sessionId),
        eq(agentSessionCompactions.status, 'completed'),
      ),
    )
    .orderBy(desc(agentSessionCompactions.version))
    .limit(1);
  return rows[0];
}

function validateRange(sourceFromSequence: number, sourceThroughSequence: number): void {
  if (
    !Number.isSafeInteger(sourceFromSequence) ||
    !Number.isSafeInteger(sourceThroughSequence) ||
    sourceFromSequence < 1 ||
    sourceThroughSequence < sourceFromSequence
  ) {
    throw new Error('Agent Session compaction source range is invalid');
  }
}

function getTranscriptEntry(
  database: AgentPressDatabase,
  sessionId: string,
  sequence: number,
): Promise<{ readonly id: string } | undefined> {
  return database
    .select({ id: agentTranscriptEntries.id })
    .from(agentTranscriptEntries)
    .where(
      and(
        eq(agentTranscriptEntries.sessionId, sessionId),
        eq(agentTranscriptEntries.sequence, sequence),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
}

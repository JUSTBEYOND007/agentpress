import { and, asc, desc, eq, inArray, lte, max } from 'drizzle-orm';

import type { AgentPressDatabase } from './postgres.js';
import {
  actionProposals,
  agentRuns,
  agentTasks,
  approvals,
  artifacts,
  artifactVersions,
  conversationBranches,
  conversationCompactions,
  conversationMessages,
  editProposalBatches,
  editProposals,
  evidenceRecords,
  memoryCandidates,
  mentionBindings,
  modelSelections,
  rootRequests,
  runSkillBindings,
  taskResults,
  toolCalls,
} from './schema.js';

export type ConversationCompactionReason = 'automatic' | 'manual' | 'mid_turn' | 'branch_fork';
export type ConversationCompactionReserveProvenance = 'default' | 'explicit' | 'proportional';

type ConversationCompactionBase = {
  readonly id: string;
  readonly branchId: string;
  readonly reason: ConversationCompactionReason;
  readonly sourceFromSequence: number;
  readonly sourceThroughSequence: number;
  readonly tokensBefore: number;
  readonly model: string;
  readonly promptVersion: string;
  readonly reserveTokens: number;
  readonly reserveProvenance: ConversationCompactionReserveProvenance;
};

export type AppendConversationCompactionInput = ConversationCompactionBase &
  (
    | {
        readonly firstKeptMessageSequence: number;
        readonly summary: string;
        readonly shortSummary?: string;
        readonly tokenCount: number;
        readonly preserveData: Readonly<Record<string, unknown>>;
        readonly failure?: never;
      }
    | {
        readonly firstKeptMessageSequence?: never;
        readonly summary?: never;
        readonly shortSummary?: never;
        readonly tokenCount?: never;
        readonly preserveData?: Readonly<Record<string, unknown>>;
        readonly failure: {
          readonly code: string;
          readonly message: string;
          readonly retryable: boolean;
          readonly details?: Readonly<Record<string, unknown>>;
        };
      }
  );

export async function appendConversationCompaction(
  database: AgentPressDatabase,
  input: AppendConversationCompactionInput,
): Promise<typeof conversationCompactions.$inferSelect> {
  return database.transaction(async (transaction) => {
    const branches = await transaction
      .select({ id: conversationBranches.id })
      .from(conversationBranches)
      .where(eq(conversationBranches.id, input.branchId))
      .for('update')
      .limit(1);
    if (!branches[0]) throw new Error(`Conversation branch ${input.branchId} does not exist`);
    if (
      !Number.isSafeInteger(input.sourceFromSequence) ||
      !Number.isSafeInteger(input.sourceThroughSequence) ||
      input.sourceFromSequence < 1 ||
      input.sourceThroughSequence < input.sourceFromSequence
    ) {
      throw new Error('Conversation compaction source range is invalid');
    }

    const [sourceFrom] = await transaction
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.branchId, input.branchId),
          eq(conversationMessages.sequence, input.sourceFromSequence),
          eq(conversationMessages.stable, true),
        ),
      )
      .limit(1);
    const [sourceThrough] = await transaction
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.branchId, input.branchId),
          eq(conversationMessages.sequence, input.sourceThroughSequence),
          eq(conversationMessages.stable, true),
        ),
      )
      .limit(1);
    if (!sourceFrom || !sourceThrough) {
      throw new Error('Conversation compaction source range must reference stable branch messages');
    }

    const versions = await transaction
      .select({ version: max(conversationCompactions.version) })
      .from(conversationCompactions)
      .where(eq(conversationCompactions.branchId, input.branchId));
    const previousRows = await transaction
      .select()
      .from(conversationCompactions)
      .where(
        and(
          eq(conversationCompactions.branchId, input.branchId),
          eq(conversationCompactions.status, 'completed'),
        ),
      )
      .orderBy(desc(conversationCompactions.version))
      .limit(1);
    const previous = previousRows[0];

    if (input.failure === undefined) {
      if (input.summary.trim().length === 0) throw new Error('Conversation summary is empty');
      if (
        !Number.isSafeInteger(input.firstKeptMessageSequence) ||
        input.firstKeptMessageSequence <= input.sourceThroughSequence
      ) {
        throw new Error('Conversation compaction keep boundary is invalid');
      }
      if (previous && input.sourceFromSequence !== previous.firstKeptMessageSequence) {
        throw new Error('Incremental compaction must continue from the previous keep boundary');
      }
      const keptRows = await transaction
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.branchId, input.branchId),
            eq(conversationMessages.sequence, input.firstKeptMessageSequence),
            eq(conversationMessages.stable, true),
          ),
        )
        .limit(1);
      const kept = keptRows[0];
      if (!kept)
        throw new Error('Conversation compaction keep boundary is not a stable branch message');
      const shortSummary = input.shortSummary?.trim();
      const inserted = await transaction
        .insert(conversationCompactions)
        .values({
          ...input,
          version: (versions[0]?.version ?? 0) + 1,
          status: 'completed',
          previousCompactionId: previous?.id,
          sourceFromMessageId: sourceFrom.id,
          sourceThroughMessageId: sourceThrough.id,
          firstKeptMessageId: kept.id,
          preserveData: input.preserveData,
          summary: input.summary.trim(),
          shortSummary: shortSummary === '' ? null : (shortSummary ?? null),
        })
        .returning();
      const persisted = inserted[0];
      if (!persisted) throw new Error(`Conversation compaction ${input.id} was not persisted`);
      return persisted;
    }

    const inserted = await transaction
      .insert(conversationCompactions)
      .values({
        id: input.id,
        branchId: input.branchId,
        reason: input.reason,
        sourceFromSequence: input.sourceFromSequence,
        sourceThroughSequence: input.sourceThroughSequence,
        tokensBefore: input.tokensBefore,
        model: input.model,
        promptVersion: input.promptVersion,
        reserveTokens: input.reserveTokens,
        reserveProvenance: input.reserveProvenance,
        version: (versions[0]?.version ?? 0) + 1,
        status: 'failed',
        previousCompactionId: previous?.id,
        sourceFromMessageId: sourceFrom.id,
        sourceThroughMessageId: sourceThrough.id,
        preserveData: input.preserveData ?? {},
        failure: input.failure,
      })
      .returning();
    const persisted = inserted[0];
    if (!persisted) throw new Error(`Conversation compaction ${input.id} was not persisted`);
    return persisted;
  });
}

export async function getEffectiveConversationCompaction(
  database: AgentPressDatabase,
  branchId: string,
  beforeMessageSequence: number,
): Promise<typeof conversationCompactions.$inferSelect | undefined> {
  const rows = await database
    .select()
    .from(conversationCompactions)
    .where(
      and(
        eq(conversationCompactions.branchId, branchId),
        eq(conversationCompactions.status, 'completed'),
        lte(conversationCompactions.firstKeptMessageSequence, beforeMessageSequence),
      ),
    )
    .orderBy(desc(conversationCompactions.version))
    .limit(1);
  return rows[0];
}

/**
 * Collects references that must remain visible when the corresponding dialogue
 * is summarized. The references point back to PostgreSQL facts; they are not
 * copied into the model-generated summary.
 */
export async function collectConversationCompactionPreserveData(
  database: AgentPressDatabase,
  branchId: string,
  sourceThroughSequence: number,
): Promise<Readonly<Record<string, unknown>>> {
  const runRows = await database
    .select({
      runId: agentRuns.id,
      workspaceId: agentRuns.workspaceId,
      userId: rootRequests.requestedByUserId,
    })
    .from(agentRuns)
    .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
    .innerJoin(conversationMessages, eq(conversationMessages.id, rootRequests.messageId))
    .where(
      and(
        eq(agentRuns.branchId, branchId),
        lte(conversationMessages.sequence, sourceThroughSequence),
      ),
    )
    .orderBy(asc(conversationMessages.sequence));
  const runIds = uniqueSorted(runRows.map(({ runId }) => runId));
  if (runIds.length === 0) return emptyPreserveData();

  const [
    toolRows,
    approvalRows,
    evidenceRows,
    artifactRows,
    artifactVersionRows,
    taskResultRows,
    editProposalRows,
    actionProposalRows,
    skillRows,
    mentionRows,
    modelRows,
  ] = await Promise.all([
    database
      .select({ id: toolCalls.id, status: toolCalls.status })
      .from(toolCalls)
      .where(inArray(toolCalls.runId, runIds)),
    database
      .select({ id: approvals.id })
      .from(approvals)
      .innerJoin(toolCalls, eq(toolCalls.id, approvals.toolCallId))
      .where(and(inArray(toolCalls.runId, runIds), eq(approvals.decision, 'pending'))),
    database
      .select({ id: evidenceRecords.id })
      .from(evidenceRecords)
      .where(inArray(evidenceRecords.runId, runIds)),
    database.select({ id: artifacts.id }).from(artifacts).where(inArray(artifacts.runId, runIds)),
    database
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(inArray(artifacts.runId, runIds)),
    database
      .select({ id: taskResults.id })
      .from(taskResults)
      .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
      .where(inArray(agentTasks.runId, runIds)),
    database
      .select({
        id: editProposals.id,
        status: editProposals.status,
        baseRevisionId: editProposals.baseRevisionId,
      })
      .from(editProposals)
      .where(inArray(editProposals.runId, runIds)),
    database
      .select({
        id: actionProposals.id,
        status: actionProposals.status,
        baseRevisionId: actionProposals.baseRevisionId,
      })
      .from(actionProposals)
      .where(inArray(actionProposals.sourceRunId, runIds)),
    database
      .select({ skillRevisionId: runSkillBindings.skillRevisionId })
      .from(runSkillBindings)
      .where(inArray(runSkillBindings.runId, runIds)),
    database
      .select({ revision: mentionBindings.revision })
      .from(mentionBindings)
      .where(inArray(mentionBindings.runId, runIds)),
    database
      .select({ id: modelSelections.id })
      .from(modelSelections)
      .where(inArray(modelSelections.runId, runIds)),
  ]);

  const proposalIds = editProposalRows.map(({ id }) => id);
  const batchRows =
    proposalIds.length === 0
      ? []
      : await database
          .select({ id: editProposalBatches.id })
          .from(editProposalBatches)
          .where(inArray(editProposalBatches.proposalId, proposalIds));
  const memoryRows = await database
    .select({ id: memoryCandidates.id })
    .from(memoryCandidates)
    .where(inArray(memoryCandidates.sourceRunId, runIds));
  const unsettledToolStates = new Set([
    'proposed',
    'awaiting_approval',
    'approved',
    'executing',
    'outcome_unknown',
  ]);

  return {
    runIds,
    toolCallIds: uniqueSorted(toolRows.map(({ id }) => id)),
    unsettledToolCallIds: uniqueSorted(
      toolRows.filter(({ status }) => unsettledToolStates.has(status)).map(({ id }) => id),
    ),
    pendingApprovalIds: uniqueSorted(approvalRows.map(({ id }) => id)),
    evidenceIds: uniqueSorted(evidenceRows.map(({ id }) => id)),
    artifactIds: uniqueSorted(artifactRows.map(({ id }) => id)),
    artifactVersionIds: uniqueSorted(artifactVersionRows.map(({ id }) => id)),
    taskResultIds: uniqueSorted(taskResultRows.map(({ id }) => id)),
    editProposalIds: uniqueSorted(editProposalRows.map(({ id }) => id)),
    pendingEditProposalIds: uniqueSorted(
      editProposalRows
        .filter(({ status }) => status === 'pending' || status === 'partially_accepted')
        .map(({ id }) => id),
    ),
    editProposalBatchIds: uniqueSorted(batchRows.map(({ id }) => id)),
    actionProposalIds: uniqueSorted(actionProposalRows.map(({ id }) => id)),
    pendingActionProposalIds: uniqueSorted(
      actionProposalRows.filter(({ status }) => status === 'pending').map(({ id }) => id),
    ),
    articleRevisionIds: uniqueSorted([
      ...editProposalRows.map(({ baseRevisionId }) => baseRevisionId),
      ...actionProposalRows.map(({ baseRevisionId }) => baseRevisionId),
      ...mentionRows.map(({ revision }) => revision),
    ]),
    memoryCandidateIds: uniqueSorted(memoryRows.map(({ id }) => id)),
    skillRevisionIds: uniqueSorted(skillRows.map(({ skillRevisionId }) => skillRevisionId)),
    modelSelectionIds: uniqueSorted(modelRows.map(({ id }) => id)),
    costRunIds: runIds,
  };
}

function emptyPreserveData(): Readonly<Record<string, readonly string[]>> {
  return {
    runIds: [],
    toolCallIds: [],
    unsettledToolCallIds: [],
    pendingApprovalIds: [],
    evidenceIds: [],
    artifactIds: [],
    artifactVersionIds: [],
    taskResultIds: [],
    editProposalIds: [],
    pendingEditProposalIds: [],
    editProposalBatchIds: [],
    actionProposalIds: [],
    pendingActionProposalIds: [],
    articleRevisionIds: [],
    memoryCandidateIds: [],
    skillRevisionIds: [],
    modelSelectionIds: [],
    costRunIds: [],
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

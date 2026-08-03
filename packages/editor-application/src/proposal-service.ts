import { randomUUID } from 'node:crypto';

import {
  applyProposal,
  type ArticleDocument,
  type DiffEntry,
  type EditOperation,
  previewProposal,
  StaleEditError,
  type EditReviewMode,
} from '@agentpress/editor-patch';
import {
  articles,
  articleRevisions,
  editProposalBatches,
  editProposalDecisions,
  editProposals,
  enqueueOutboxMessage,
  type AgentPressDatabase,
  type DatabaseTransaction,
} from '@agentpress/database';
import { ARTICLE_INDEX_COMMAND_TOPIC } from '@agentpress/knowledge-retrieval';
import { hashBlock } from '@agentpress/editor-patch';
import { and, asc, eq, max, sql } from 'drizzle-orm';

import { EditorApplicationError } from './contracts.js';

type Decision = 'accepted' | 'rejected';
type StaleProposalOutcome = {
  readonly outcome: 'stale';
  readonly message: string;
};

export class ProposalService {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async create(input: {
    readonly articleId: string;
    readonly runId?: string;
    readonly sourceToolCallId?: string;
    readonly baseRevisionId?: string;
    readonly operations: readonly unknown[];
    readonly reviewMode?: EditReviewMode;
    readonly ttlMs?: number;
  }) {
    const ttlMs = input.ttlMs ?? 30 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60_000) {
      throw new RangeError('Edit proposal TTL must be between 1 minute and 24 hours');
    }
    const result = await this.database.transaction(async (transaction) => {
      if (input.sourceToolCallId) {
        const [proposalReplay, batchReplay] = await Promise.all([
          transaction
            .select()
            .from(editProposals)
            .where(eq(editProposals.sourceToolCallId, input.sourceToolCallId))
            .limit(1),
          transaction
            .select({ proposalId: editProposalBatches.proposalId })
            .from(editProposalBatches)
            .where(eq(editProposalBatches.sourceToolCallId, input.sourceToolCallId))
            .limit(1),
        ]);
        if (proposalReplay[0]) return this.snapshot(transaction, proposalReplay[0]);
        if (batchReplay[0]) {
          const replay = await transaction
            .select()
            .from(editProposals)
            .where(eq(editProposals.id, batchReplay[0].proposalId))
            .limit(1);
          if (replay[0]) return this.snapshot(transaction, replay[0]);
        }
      }
      const articleRows = await transaction
        .select()
        .from(articles)
        .where(eq(articles.id, input.articleId))
        .for('update')
        .limit(1);
      const article = articleRows[0];
      if (!article?.currentRevisionId) {
        throw new EditorApplicationError('article_not_found', 'Article has no current revision');
      }
      if (input.baseRevisionId && article.currentRevisionId !== input.baseRevisionId) {
        throw new StaleEditError('proposal', 'Article changed after the Agent Run was authorized');
      }
      const pending = await transaction
        .select()
        .from(editProposals)
        .where(and(eq(editProposals.articleId, article.id), eq(editProposals.status, 'pending')))
        .limit(1);
      const revision = await loadRevision(transaction, article.currentRevisionId);
      const operations = parseOperations(input.operations);
      const reviewMode = input.reviewMode ?? 'granular';
      if (operations.length === 0 || operations.length > 100) {
        throw new EditorApplicationError(
          'invalid_batch',
          'Edit batch must contain between 1 and 100 operations',
        );
      }
      const now = this.now();
      const expiresAt = new Date(now.getTime() + ttlMs);
      const existingProposal = pending[0];
      if (existingProposal && existingProposal.baseRevisionId !== revision.id) {
        await transaction
          .update(editProposals)
          .set({ status: 'expired', updatedAt: now })
          .where(
            and(eq(editProposals.id, existingProposal.id), eq(editProposals.status, 'pending')),
          );
        return staleProposal('Article changed while the working draft was open');
      }
      if (existingProposal) {
        if (existingProposal.reviewMode !== reviewMode) {
          throw new EditorApplicationError(
            'invalid_batch',
            'Working draft review mode cannot change',
          );
        }
        const activeBatches = await transaction
          .select()
          .from(editProposalBatches)
          .where(
            and(
              eq(editProposalBatches.proposalId, existingProposal.id),
              eq(editProposalBatches.status, 'active'),
            ),
          )
          .orderBy(asc(editProposalBatches.batchNumber));
        const existingOperations =
          activeBatches.length > 0
            ? activeBatches.flatMap((batch) => parseOperations(batch.operations))
            : parseOperations(existingProposal.operations);
        if (existingOperations.length + operations.length > 200) {
          throw new EditorApplicationError(
            'invalid_batch',
            'Working draft cannot exceed 200 operations',
          );
        }
        const working = applyProposal({
          document: revision.document as ArticleDocument,
          currentRevision: revision.id,
          proposal: {
            proposalId: existingProposal.id,
            articleId: article.id,
            baseRevision: revision.id,
            operations: existingOperations,
          },
        });
        const next = applyProposal({
          document: working.document,
          currentRevision: revision.id,
          proposal: {
            proposalId: existingProposal.id,
            articleId: article.id,
            baseRevision: revision.id,
            operations,
          },
        });
        const batchNumber = (activeBatches.at(-1)?.batchNumber ?? 0) + 1;
        await transaction.insert(editProposalBatches).values({
          id: this.createId(),
          proposalId: existingProposal.id,
          ...(input.runId || existingProposal.runId
            ? { runId: input.runId ?? existingProposal.runId ?? undefined }
            : {}),
          ...(input.sourceToolCallId ? { sourceToolCallId: input.sourceToolCallId } : {}),
          batchNumber,
          operations,
          diffs: next.diffs,
          beforeHash: working.revisionHash,
          afterHash: next.revisionHash,
          createdAt: now,
          updatedAt: now,
        });
        const allOperations = [...existingOperations, ...operations];
        const allDiffs = previewProposal(revision.document as ArticleDocument, revision.id, {
          proposalId: existingProposal.id,
          articleId: article.id,
          baseRevision: revision.id,
          operations: allOperations,
        });
        await transaction
          .update(editProposals)
          .set({ operations: allOperations, diffs: allDiffs, expiresAt, updatedAt: now })
          .where(eq(editProposals.id, existingProposal.id));
        const updated = {
          ...existingProposal,
          operations: allOperations,
          diffs: allDiffs,
          expiresAt,
          reviewMode,
        };
        return this.snapshot(transaction, updated);
      }
      const proposalId = this.createId();
      const diffs = previewProposal(revision.document as ArticleDocument, revision.id, {
        proposalId,
        articleId: article.id,
        baseRevision: revision.id,
        operations,
      });
      const rows = await transaction
        .insert(editProposals)
        .values({
          id: proposalId,
          articleId: article.id,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.sourceToolCallId ? { sourceToolCallId: input.sourceToolCallId } : {}),
          baseRevisionId: revision.id,
          operations,
          reviewMode,
          diffs,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const persistedProposal = rows[0];
      if (!persistedProposal) throw new Error('Edit proposal was not persisted');
      const applied = applyProposal({
        document: revision.document as ArticleDocument,
        currentRevision: revision.id,
        proposal: { proposalId, articleId: article.id, baseRevision: revision.id, operations },
      });
      await transaction.insert(editProposalBatches).values({
        id: this.createId(),
        proposalId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.sourceToolCallId ? { sourceToolCallId: input.sourceToolCallId } : {}),
        batchNumber: 1,
        operations,
        diffs,
        beforeHash: revision.documentHash,
        afterHash: applied.revisionHash,
        createdAt: now,
        updatedAt: now,
      });
      return this.snapshot(transaction, persistedProposal);
    });
    return unwrapStaleProposal(result);
  }

  public async getPending(articleId: string) {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(editProposals)
        .where(and(eq(editProposals.articleId, articleId), eq(editProposals.status, 'pending')))
        .orderBy(asc(editProposals.createdAt))
        .limit(1);
      const proposal = rows[0];
      if (!proposal) return undefined;
      const hasNoOperations = parseOperations(proposal.operations).length === 0;
      const articleRows = await transaction
        .select({ currentRevisionId: articles.currentRevisionId })
        .from(articles)
        .where(eq(articles.id, proposal.articleId))
        .limit(1);
      if (
        hasNoOperations ||
        proposal.expiresAt <= this.now() ||
        articleRows[0]?.currentRevisionId !== proposal.baseRevisionId
      ) {
        await transaction
          .update(editProposals)
          .set({ status: hasNoOperations ? 'rejected' : 'expired', updatedAt: this.now() })
          .where(and(eq(editProposals.id, proposal.id), eq(editProposals.status, 'pending')));
        return undefined;
      }
      return this.snapshot(transaction, proposal);
    });
  }

  public async decideOperation(input: {
    readonly proposalId: string;
    readonly operationId: string;
    readonly userId: string;
    readonly decision: Decision;
  }) {
    const result = await this.database.transaction((transaction) =>
      this.recordDecisions(transaction, {
        proposalId: input.proposalId,
        userId: input.userId,
        decisions: new Map([[input.operationId, input.decision]]),
      }),
    );
    return unwrapStaleProposal(result);
  }

  public async decide(input: {
    readonly proposalId: string;
    readonly userId: string;
    readonly decisions: Readonly<Record<string, Decision>>;
  }) {
    const entries = Object.entries(input.decisions);
    if (entries.length === 0) {
      throw new EditorApplicationError(
        'invalid_batch',
        'At least one explicit decision is required',
      );
    }
    const result = await this.database.transaction((transaction) =>
      this.recordDecisions(transaction, {
        proposalId: input.proposalId,
        userId: input.userId,
        decisions: new Map(entries),
      }),
    );
    return unwrapStaleProposal(result);
  }

  public async revertBatch(input: {
    readonly proposalId: string;
    readonly batchId: string;
    readonly userId: string;
  }) {
    if (!input.userId) throw new EditorApplicationError('invalid_batch', 'User is required');
    return this.database.transaction(async (transaction) => {
      const batchRows = await transaction
        .select()
        .from(editProposalBatches)
        .innerJoin(editProposals, eq(editProposals.id, editProposalBatches.proposalId))
        .where(
          and(
            eq(editProposalBatches.id, input.batchId),
            eq(editProposalBatches.proposalId, input.proposalId),
          ),
        )
        .for('update')
        .limit(1);
      const row = batchRows[0];
      if (row?.edit_proposals.status !== 'pending') {
        throw new EditorApplicationError('invalid_batch', 'Edit batch is no longer pending');
      }
      if (row.edit_proposal_batches.status === 'reverted') {
        return this.snapshot(transaction, row.edit_proposals);
      }
      const active = await transaction
        .select()
        .from(editProposalBatches)
        .where(
          and(
            eq(editProposalBatches.proposalId, row.edit_proposals.id),
            eq(editProposalBatches.status, 'active'),
          ),
        )
        .orderBy(asc(editProposalBatches.batchNumber));
      if (active.at(-1)?.id !== input.batchId) {
        throw new EditorApplicationError(
          'invalid_batch',
          'Only the latest edit batch can be reverted',
        );
      }
      await transaction
        .update(editProposalBatches)
        .set({ status: 'reverted', updatedAt: this.now() })
        .where(eq(editProposalBatches.id, input.batchId));
      const remaining = active.filter(({ id }) => id !== input.batchId);
      const operations = remaining.flatMap((batch) => parseOperations(batch.operations));
      const revision = await loadRevision(transaction, row.edit_proposals.baseRevisionId);
      const diffs = previewProposal(revision.document as ArticleDocument, revision.id, {
        proposalId: row.edit_proposals.id,
        articleId: row.edit_proposals.articleId,
        baseRevision: revision.id,
        operations,
      });
      await transaction
        .update(editProposals)
        .set({
          operations,
          diffs,
          status: operations.length === 0 ? 'rejected' : 'pending',
          updatedAt: this.now(),
        })
        .where(eq(editProposals.id, row.edit_proposals.id));
      return this.snapshot(transaction, {
        ...row.edit_proposals,
        operations,
        diffs,
        status: operations.length === 0 ? 'rejected' : 'pending',
      });
    });
  }

  private async recordDecisions(
    transaction: DatabaseTransaction,
    input: {
      readonly proposalId: string;
      readonly userId: string;
      readonly decisions: ReadonlyMap<string, Decision>;
    },
  ) {
    const proposals = await transaction
      .select()
      .from(editProposals)
      .where(eq(editProposals.id, input.proposalId))
      .for('update')
      .limit(1);
    const proposal = proposals[0];
    if (!proposal) {
      throw new EditorApplicationError('article_not_found', 'Edit proposal does not exist');
    }
    const articleRows = await transaction
      .select({ currentRevisionId: articles.currentRevisionId })
      .from(articles)
      .where(eq(articles.id, proposal.articleId))
      .for('update')
      .limit(1);
    if (
      proposal.status === 'pending' &&
      (proposal.expiresAt <= this.now() ||
        articleRows[0]?.currentRevisionId !== proposal.baseRevisionId)
    ) {
      await transaction
        .update(editProposals)
        .set({ status: 'expired', updatedAt: this.now() })
        .where(and(eq(editProposals.id, proposal.id), eq(editProposals.status, 'pending')));
      return staleProposal('Edit proposal is stale because the article revision changed');
    }
    const operations = parseOperations(proposal.operations);
    const operationIds = new Set(operations.map(({ operationId }) => operationId));
    for (const operationId of input.decisions.keys()) {
      if (!operationIds.has(operationId)) {
        throw new EditorApplicationError(
          'invalid_batch',
          'Edit operation does not belong to proposal',
        );
      }
    }
    const persisted = await loadDecisions(transaction, proposal.id);
    if (proposal.reviewMode === 'document' && input.decisions.size > 0) {
      const requested = new Set(input.decisions.values());
      if (requested.size !== 1) {
        throw new EditorApplicationError(
          'invalid_batch',
          'Whole-article proposals require one decision for the entire document',
        );
      }
      const decision = [...requested][0];
      if (!decision) throw new EditorApplicationError('invalid_batch', 'Decision is required');
      input = {
        ...input,
        decisions: new Map([...operationIds].map((operationId) => [operationId, decision])),
      };
    }
    for (const [operationId, decision] of input.decisions) {
      const existing = persisted.get(operationId);
      if (existing && existing !== decision) {
        throw new StaleEditError('proposal', 'Edit operation already has the opposite decision');
      }
    }
    const missing = [...input.decisions].filter(([operationId]) => !persisted.has(operationId));
    if (missing.length > 0) {
      if (proposal.status !== 'pending' || proposal.expiresAt <= this.now()) {
        throw new StaleEditError('proposal', 'Edit proposal is expired or already settled');
      }
      await transaction.insert(editProposalDecisions).values(
        missing.map(([operationId, decision]) => ({
          proposalId: proposal.id,
          operationId,
          decision,
          decidedByUserId: input.userId,
        })),
      );
    }
    const decisions = new Map([...persisted, ...input.decisions]);
    if (proposal.status !== 'pending' || decisions.size < operations.length) {
      return this.snapshot(transaction, proposal);
    }
    return this.settle(transaction, proposal, operations, decisions, input.userId);
  }

  private async snapshot(
    transaction: DatabaseTransaction,
    proposal: typeof editProposals.$inferSelect,
  ) {
    const operations = parseOperations(proposal.operations);
    let diffs = proposal.diffs as readonly DiffEntry[];
    if (diffs.length === 0) {
      const revision = await loadRevision(transaction, proposal.baseRevisionId);
      diffs = previewProposal(revision.document as ArticleDocument, revision.id, {
        proposalId: proposal.id,
        articleId: proposal.articleId,
        baseRevision: proposal.baseRevisionId,
        operations,
      });
      await transaction
        .update(editProposals)
        .set({ diffs })
        .where(eq(editProposals.id, proposal.id));
    }
    const decisions = await loadDecisions(transaction, proposal.id);
    const baseRevision = await loadRevision(transaction, proposal.baseRevisionId);
    const working = applyProposal({
      document: baseRevision.document as ArticleDocument,
      currentRevision: baseRevision.id,
      proposal: {
        proposalId: proposal.id,
        articleId: proposal.articleId,
        baseRevision: baseRevision.id,
        operations,
      },
    });
    const batches = await transaction
      .select({
        id: editProposalBatches.id,
        runId: editProposalBatches.runId,
        batchNumber: editProposalBatches.batchNumber,
        status: editProposalBatches.status,
        beforeHash: editProposalBatches.beforeHash,
        afterHash: editProposalBatches.afterHash,
      })
      .from(editProposalBatches)
      .where(eq(editProposalBatches.proposalId, proposal.id))
      .orderBy(asc(editProposalBatches.batchNumber));
    return {
      proposalId: proposal.id,
      articleId: proposal.articleId,
      baseRevisionId: proposal.baseRevisionId,
      operations,
      reviewMode: proposal.reviewMode as EditReviewMode,
      diffs,
      decisions: Object.fromEntries(decisions),
      batches,
      workingRevisionHash: working.revisionHash,
      workingDocument: working.document,
      workingBlockHashes: Object.fromEntries(
        working.document.content.map((block) => [block.attrs.blockId, hashBlock(block)]),
      ),
      status: proposal.status,
      expiresAt: proposal.expiresAt.toISOString(),
    };
  }

  private async settle(
    transaction: DatabaseTransaction,
    proposal: typeof editProposals.$inferSelect,
    operations: readonly EditOperation[],
    decisions: ReadonlyMap<string, Decision>,
    userId: string,
  ) {
    const articleRows = await transaction
      .select()
      .from(articles)
      .where(eq(articles.id, proposal.articleId))
      .for('update')
      .limit(1);
    const article = articleRows[0];
    if (!article?.currentRevisionId) {
      throw new EditorApplicationError('article_not_found', 'Article has no current revision');
    }
    if (article.currentRevisionId !== proposal.baseRevisionId) {
      throw new StaleEditError('proposal', 'Article revision changed after proposal creation');
    }
    const revision = await loadRevision(transaction, article.currentRevisionId);
    const result = applyProposal({
      document: revision.document as ArticleDocument,
      currentRevision: revision.id,
      proposal: {
        proposalId: proposal.id,
        articleId: proposal.articleId,
        baseRevision: proposal.baseRevisionId,
        operations,
      },
      decisions: Object.fromEntries(decisions),
    });
    const accepted = result.appliedOperationIds.length;
    const status =
      accepted === 0
        ? 'rejected'
        : accepted === operations.length
          ? 'accepted'
          : 'partially_accepted';
    let revisionId: string | undefined;
    if (accepted > 0) {
      revisionId = await persistRevision(
        transaction,
        article,
        revision,
        result.document,
        result.revisionHash,
        userId,
        this.createId,
        this.now,
      );
    }
    await transaction
      .update(editProposals)
      .set({ status, updatedAt: this.now() })
      .where(and(eq(editProposals.id, proposal.id), eq(editProposals.status, 'pending')));
    return {
      proposalId: proposal.id,
      articleId: proposal.articleId,
      baseRevisionId: proposal.baseRevisionId,
      operations,
      reviewMode: proposal.reviewMode as EditReviewMode,
      diffs: proposal.diffs,
      decisions: Object.fromEntries(decisions),
      status,
      ...(revisionId ? { revisionId } : {}),
      appliedOperationIds: result.appliedOperationIds,
    };
  }
}

function staleProposal(message: string): StaleProposalOutcome {
  return { outcome: 'stale', message };
}

function unwrapStaleProposal<T>(result: T | StaleProposalOutcome): T {
  if (isStaleProposalOutcome(result)) throw new StaleEditError('proposal', result.message);
  return result;
}

function isStaleProposalOutcome(value: unknown): value is StaleProposalOutcome {
  return (
    typeof value === 'object' && value !== null && 'outcome' in value && value.outcome === 'stale'
  );
}

async function persistRevision(
  transaction: DatabaseTransaction,
  article: typeof articles.$inferSelect,
  revision: typeof articleRevisions.$inferSelect,
  document: ArticleDocument,
  revisionHash: string,
  userId: string,
  createId: () => string,
  now: () => Date,
): Promise<string> {
  const revisionId = createId();
  const aggregate = await transaction
    .select({ value: max(articleRevisions.revisionNumber) })
    .from(articleRevisions)
    .where(eq(articleRevisions.articleId, article.id));
  await transaction.insert(articleRevisions).values({
    id: revisionId,
    articleId: article.id,
    revisionNumber: (aggregate[0]?.value ?? 0) + 1,
    schemaVersion: revision.schemaVersion,
    document,
    documentHash: revisionHash,
    source: 'proposal',
    createdByUserId: userId,
  });
  const updated = await transaction
    .update(articles)
    .set({ currentRevisionId: revisionId, version: sql`${articles.version} + 1`, updatedAt: now() })
    .where(and(eq(articles.id, article.id), eq(articles.currentRevisionId, revision.id)))
    .returning({ id: articles.id });
  if (updated.length !== 1)
    throw new StaleEditError('proposal', 'Article changed while settling proposal');
  const messageId = createId();
  await enqueueOutboxMessage(transaction, {
    id: messageId,
    aggregateType: 'ArticleRevision',
    aggregateId: revisionId,
    topic: ARTICLE_INDEX_COMMAND_TOPIC,
    messageKey: article.id,
    payload: { command: 'article.index', messageId, revisionId },
    occurredAt: now(),
  });
  return revisionId;
}

async function loadRevision(transaction: DatabaseTransaction, revisionId: string) {
  const rows = await transaction
    .select()
    .from(articleRevisions)
    .where(eq(articleRevisions.id, revisionId))
    .limit(1);
  const revision = rows[0];
  if (!revision)
    throw new EditorApplicationError('article_not_found', 'Article revision does not exist');
  return revision;
}

async function loadDecisions(transaction: DatabaseTransaction, proposalId: string) {
  const rows = await transaction
    .select({
      operationId: editProposalDecisions.operationId,
      decision: editProposalDecisions.decision,
    })
    .from(editProposalDecisions)
    .where(eq(editProposalDecisions.proposalId, proposalId));
  return new Map(rows.map(({ operationId, decision }) => [operationId, decision as Decision]));
}

function parseOperations(value: readonly unknown[]): readonly EditOperation[] {
  return value.map((item) => {
    if (typeof item !== 'object' || item === null)
      throw new Error('Proposal operation must be an object');
    const operation = item as Record<string, unknown>;
    if (
      typeof operation.operationId !== 'string' ||
      !['insert', 'replace', 'delete', 'move', 'update_attrs'].includes(String(operation.kind))
    ) {
      throw new Error('Proposal operation is invalid');
    }
    return item as EditOperation;
  });
}

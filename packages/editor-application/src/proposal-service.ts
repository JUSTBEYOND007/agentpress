import { randomUUID } from 'node:crypto';

import {
  applyProposal,
  type ArticleDocument,
  type DiffEntry,
  type EditOperation,
  previewProposal,
  StaleEditError,
} from '@agentpress/editor-patch';
import {
  articles,
  articleRevisions,
  editProposalDecisions,
  editProposals,
  enqueueOutboxMessage,
  type AgentPressDatabase,
  type DatabaseTransaction,
} from '@agentpress/database';
import { ARTICLE_INDEX_COMMAND_TOPIC } from '@agentpress/knowledge-retrieval';
import { and, asc, eq, max, sql } from 'drizzle-orm';

import { EditorApplicationError } from './contracts.js';

type Decision = 'accepted' | 'rejected';

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
    readonly ttlMs?: number;
  }) {
    const ttlMs = input.ttlMs ?? 30 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60_000) {
      throw new RangeError('Edit proposal TTL must be between 1 minute and 24 hours');
    }
    return this.database.transaction(async (transaction) => {
      if (input.sourceToolCallId) {
        const replay = await transaction
          .select()
          .from(editProposals)
          .where(eq(editProposals.sourceToolCallId, input.sourceToolCallId))
          .limit(1);
        if (replay[0]) return this.snapshot(transaction, replay[0]);
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
        .select({ id: editProposals.id })
        .from(editProposals)
        .where(and(eq(editProposals.articleId, article.id), eq(editProposals.status, 'pending')))
        .limit(1);
      if (pending[0]) {
        throw new EditorApplicationError(
          'invalid_batch',
          'Article already has a pending edit proposal; finish that review first',
        );
      }
      const revision = await loadRevision(transaction, article.currentRevisionId);
      const operations = parseOperations(input.operations);
      if (operations.length === 0 || operations.length > 200) {
        throw new EditorApplicationError(
          'invalid_batch',
          'Edit proposal must contain between 1 and 200 operations',
        );
      }
      const proposalId = this.createId();
      const diffs = previewProposal(revision.document as ArticleDocument, revision.id, {
        proposalId,
        articleId: article.id,
        baseRevision: revision.id,
        operations,
      });
      const now = this.now();
      const expiresAt = new Date(now.getTime() + ttlMs);
      const rows = await transaction
        .insert(editProposals)
        .values({
          id: proposalId,
          articleId: article.id,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.sourceToolCallId ? { sourceToolCallId: input.sourceToolCallId } : {}),
          baseRevisionId: revision.id,
          operations,
          diffs,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const proposal = rows[0];
      if (!proposal) throw new Error('Edit proposal was not persisted');
      return this.snapshot(transaction, proposal);
    });
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
      if (proposal.expiresAt <= this.now()) {
        await transaction
          .update(editProposals)
          .set({ status: 'expired', updatedAt: this.now() })
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
    return this.database.transaction((transaction) =>
      this.recordDecisions(transaction, {
        proposalId: input.proposalId,
        userId: input.userId,
        decisions: new Map([[input.operationId, input.decision]]),
      }),
    );
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
    return this.database.transaction((transaction) =>
      this.recordDecisions(transaction, {
        proposalId: input.proposalId,
        userId: input.userId,
        decisions: new Map(entries),
      }),
    );
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
    return {
      proposalId: proposal.id,
      articleId: proposal.articleId,
      baseRevisionId: proposal.baseRevisionId,
      operations,
      diffs,
      decisions: Object.fromEntries(decisions),
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
      diffs: proposal.diffs,
      decisions: Object.fromEntries(decisions),
      status,
      ...(revisionId ? { revisionId } : {}),
      appliedOperationIds: result.appliedOperationIds,
    };
  }
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

import { randomUUID } from 'node:crypto';
import {
  applyProposal,
  type ArticleDocument,
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
} from '@agentpress/database';
import { ARTICLE_INDEX_COMMAND_TOPIC } from '@agentpress/knowledge-retrieval';
import { and, eq, max, sql } from 'drizzle-orm';
import { EditorApplicationError } from './contracts.js';

export class ProposalService {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}
  public async create(input: {
    readonly articleId: string;
    readonly runId?: string;
    readonly operations: readonly unknown[];
    readonly ttlMs?: number;
  }) {
    const ttlMs = input.ttlMs ?? 30 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60_000) {
      throw new RangeError('Edit proposal TTL must be between 1 minute and 24 hours');
    }
    return this.database.transaction(async (transaction) => {
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
      const revisionRows = await transaction
        .select()
        .from(articleRevisions)
        .where(eq(articleRevisions.id, article.currentRevisionId))
        .limit(1);
      const revision = revisionRows[0];
      if (!revision) {
        throw new EditorApplicationError('article_not_found', 'Current revision does not exist');
      }
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
      const expiresAt = new Date(this.now().getTime() + ttlMs);
      await transaction.insert(editProposals).values({
        id: proposalId,
        articleId: article.id,
        ...(input.runId ? { runId: input.runId } : {}),
        baseRevisionId: revision.id,
        operations,
        expiresAt,
        createdAt: this.now(),
        updatedAt: this.now(),
      });
      return {
        proposalId,
        articleId: article.id,
        baseRevisionId: revision.id,
        operations,
        diffs,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  public async decide(input: {
    readonly proposalId: string;
    readonly userId: string;
    readonly decisions: Readonly<Record<string, 'accepted' | 'rejected'>>;
  }) {
    return this.database.transaction(async (transaction) => {
      const proposals = await transaction
        .select()
        .from(editProposals)
        .where(eq(editProposals.id, input.proposalId))
        .for('update')
        .limit(1);
      const proposal = proposals[0];
      if (!proposal)
        throw new EditorApplicationError('article_not_found', 'Edit proposal does not exist');
      if (proposal.status !== 'pending' || proposal.expiresAt <= this.now())
        throw new StaleEditError('proposal', 'Edit proposal is expired or already decided');
      const articleRows = await transaction
        .select()
        .from(articles)
        .where(eq(articles.id, proposal.articleId))
        .for('update')
        .limit(1);
      const article = articleRows[0];
      if (!article?.currentRevisionId)
        throw new EditorApplicationError('article_not_found', 'Article has no current revision');
      if (article.currentRevisionId !== proposal.baseRevisionId)
        throw new StaleEditError('proposal', 'Article revision changed after proposal creation');
      const revisions = await transaction
        .select()
        .from(articleRevisions)
        .where(eq(articleRevisions.id, article.currentRevisionId))
        .limit(1);
      const revision = revisions[0];
      if (!revision)
        throw new EditorApplicationError('article_not_found', 'Current revision does not exist');
      const operations = parseOperations(proposal.operations);
      const result = applyProposal({
        document: revision.document as ArticleDocument,
        currentRevision: revision.id,
        proposal: {
          proposalId: proposal.id,
          articleId: proposal.articleId,
          baseRevision: proposal.baseRevisionId,
          operations,
        },
        decisions: input.decisions,
      });
      for (const operation of operations) {
        const decision = input.decisions[operation.operationId] ?? 'accepted';
        await transaction
          .insert(editProposalDecisions)
          .values({
            proposalId: proposal.id,
            operationId: operation.operationId,
            decision,
            decidedByUserId: input.userId,
          })
          .onConflictDoNothing();
      }
      const accepted = result.appliedOperationIds.length;
      const status =
        accepted === 0
          ? 'rejected'
          : accepted === operations.length
            ? 'accepted'
            : 'partially_accepted';
      let revisionId: string | undefined;
      if (accepted > 0) {
        revisionId = this.createId();
        const aggregate = await transaction
          .select({ value: max(articleRevisions.revisionNumber) })
          .from(articleRevisions)
          .where(eq(articleRevisions.articleId, article.id));
        const revisionNumber = (aggregate[0]?.value ?? 0) + 1;
        await transaction.insert(articleRevisions).values({
          id: revisionId,
          articleId: article.id,
          revisionNumber,
          schemaVersion: revision.schemaVersion,
          document: result.document,
          documentHash: result.revisionHash,
          source: 'proposal',
          createdByUserId: input.userId,
        });
        await transaction
          .update(articles)
          .set({
            currentRevisionId: revisionId,
            version: sql`${articles.version} + 1`,
            updatedAt: this.now(),
          })
          .where(
            and(
              eq(articles.id, article.id),
              eq(articles.currentRevisionId, proposal.baseRevisionId),
            ),
          );
        const indexMessageId = this.createId();
        await enqueueOutboxMessage(transaction, {
          id: indexMessageId,
          aggregateType: 'ArticleRevision',
          aggregateId: revisionId,
          topic: ARTICLE_INDEX_COMMAND_TOPIC,
          messageKey: article.id,
          payload: {
            command: 'article.index',
            messageId: indexMessageId,
            revisionId,
          },
          occurredAt: this.now(),
        });
      }
      await transaction
        .update(editProposals)
        .set({ status, updatedAt: this.now() })
        .where(eq(editProposals.id, proposal.id));
      return {
        proposalId: proposal.id,
        status,
        revisionId,
        diffs: result.diffs,
        appliedOperationIds: result.appliedOperationIds,
      };
    });
  }
}

function parseOperations(value: readonly unknown[]): readonly EditOperation[] {
  return value.map((item) => {
    if (typeof item !== 'object' || item === null)
      throw new Error('Proposal operation must be an object');
    const operation = item as Record<string, unknown>;
    if (
      typeof operation.operationId !== 'string' ||
      !['insert', 'replace', 'delete', 'move', 'update_attrs'].includes(String(operation.kind))
    )
      throw new Error('Proposal operation is invalid');
    return item as EditOperation;
  });
}

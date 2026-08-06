import { randomUUID } from 'node:crypto';

import {
  applyProposal,
  type ArticleDocument,
  previewProposal,
  StaleEditError,
  type EditReviewMode,
} from '@agentpress/editor-patch';
import {
  articles,
  editProposalBatches,
  editProposals,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, asc, eq } from 'drizzle-orm';

import { EditorApplicationError } from './contracts.js';
import {
  loadRevision,
  ProposalWorkflowService,
  staleProposal,
  unwrapStaleProposal,
} from './proposal-workflow-service.js';
import { normalizeOperations, parseOperations } from './proposal-operation-policy.js';

export class ProposalService {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.workflow = new ProposalWorkflowService(database, createId, now);
  }

  private readonly workflow: ProposalWorkflowService;

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
        if (proposalReplay[0]) return this.workflow.snapshot(transaction, proposalReplay[0]);
        if (batchReplay[0]) {
          const replay = await transaction
            .select()
            .from(editProposals)
            .where(eq(editProposals.id, batchReplay[0].proposalId))
            .limit(1);
          if (replay[0]) return this.workflow.snapshot(transaction, replay[0]);
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
      const reviewMode = input.reviewMode ?? 'granular';
      const operations = normalizeOperations(
        parseOperations(input.operations),
        revision.document as ArticleDocument,
        reviewMode,
      );
      const maxOperations = reviewMode === 'document' ? 400 : 100;
      if (operations.length === 0 || operations.length > maxOperations) {
        throw new EditorApplicationError(
          'invalid_batch',
          `Edit batch must contain between 1 and ${String(maxOperations)} operations`,
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
        return this.workflow.snapshot(transaction, updated);
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
      return this.workflow.snapshot(transaction, persistedProposal);
    });
    return unwrapStaleProposal(result);
  }

  public getPending(articleId: string) {
    return this.workflow.getPending(articleId);
  }

  public decideOperation(input: Parameters<ProposalWorkflowService['decideOperation']>[0]) {
    return this.workflow.decideOperation(input);
  }

  public decide(input: Parameters<ProposalWorkflowService['decide']>[0]) {
    return this.workflow.decide(input);
  }

  public revertBatch(input: Parameters<ProposalWorkflowService['revertBatch']>[0]) {
    return this.workflow.revertBatch(input);
  }
}

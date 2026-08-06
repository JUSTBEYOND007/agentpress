import { createHash } from 'node:crypto';

import { reviewRounds, type AgentPressDatabase } from '@agentpress/database';
import { and, eq } from 'drizzle-orm';

import type {
  ArticleReviewCyclePort,
  ArticleReviewSelectionReason,
  PersistedArticleReviewRound,
} from './article-review-cycle.js';

type ArticleReviewStoreOptions = {
  readonly database: AgentPressDatabase;
  readonly taskId: string;
  readonly reviewer: 'editor' | 'fact_checker';
  readonly createId: () => string;
};

/** Persists review facts only; model dispatch remains owned by ArticleReviewCycle. */
export class ArticleReviewStore implements Pick<
  ArticleReviewCyclePort,
  'recordRound' | 'recordSelection'
> {
  public constructor(private readonly options: ArticleReviewStoreOptions) {}

  public async recordRound(round: PersistedArticleReviewRound): Promise<void> {
    const candidate = round.candidate;
    const inputHash = createHash('sha256')
      .update(
        `${candidate.candidate.baseRevisionId}:${JSON.stringify(candidate.candidate.document)}`,
      )
      .digest('hex');
    const outputHash = createHash('sha256')
      .update(JSON.stringify(candidate.candidate.document))
      .digest('hex');
    const issues = [...candidate.deterministic.issues, ...candidate.modelIssues];
    await this.options.database.insert(reviewRounds).values({
      id: this.options.createId(),
      taskId: this.options.taskId,
      round: round.round,
      reviewer: this.options.reviewer,
      accepted:
        round.modelPassed &&
        candidate.deterministic.valid &&
        candidate.modelIssues.every(({ severity }) => severity !== 'error'),
      issues: issues.map(({ code, message }) => `${code}: ${message}`),
      inputHash,
      outputHash,
      artifactVersionId: candidate.candidate.artifactVersionId,
      score: Math.min(
        100,
        Math.max(0, Math.round(candidate.modelScore ?? candidate.deterministic.score)),
      ),
      modelParseFailed: round.modelParseFailed,
      deterministicIssues: candidate.deterministic.issues,
      modelIssues: candidate.modelIssues,
      usage: round.usage,
    });
  }

  public async recordSelection(input: {
    readonly artifactVersionId: string;
    readonly reason: ArticleReviewSelectionReason;
  }): Promise<void> {
    await this.options.database
      .update(reviewRounds)
      .set({ selectionReason: input.reason })
      .where(
        and(
          eq(reviewRounds.taskId, this.options.taskId),
          eq(reviewRounds.artifactVersionId, input.artifactVersionId),
        ),
      );
  }
}

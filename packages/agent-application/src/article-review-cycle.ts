import type { RuntimeUsage } from '@agentpress/agent-runtime';

import {
  combinedScore,
  reviewArticleDeterministically,
  selectBestValidArticleCandidate,
  type ArticleReviewCandidate,
  type ArticleReviewIssue,
  type ArticleReviewPolicy,
  type ScoredReviewCandidate,
} from './article-review-policy.js';

export type ModelArticleReview =
  | {
      readonly status: 'reviewed';
      readonly passed: boolean;
      readonly score?: number;
      readonly issues: readonly ArticleReviewIssue[];
      readonly usage: RuntimeUsage;
    }
  | { readonly status: 'parse_failed'; readonly usage: RuntimeUsage };

export type ArticleRevisionAttempt =
  | {
      readonly status: 'revised';
      readonly candidate: ArticleReviewCandidate;
      readonly usage: RuntimeUsage;
    }
  | { readonly status: 'no_changes'; readonly usage: RuntimeUsage };

export type ArticleReviewBudget = {
  readonly maxRevisionRounds: number;
  readonly maxModelCalls: number;
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly passScore: number;
};

export type PersistedArticleReviewRound = {
  readonly round: number;
  readonly candidate: ScoredReviewCandidate;
  readonly modelPassed: boolean;
  readonly modelParseFailed: boolean;
  readonly usage: RuntimeUsage;
};

export type ArticleReviewCyclePort = {
  readonly review?: (
    candidate: ArticleReviewCandidate,
    signal?: AbortSignal,
  ) => Promise<ModelArticleReview>;
  readonly revise?: (
    candidate: ArticleReviewCandidate,
    issues: readonly ArticleReviewIssue[],
    signal?: AbortSignal,
  ) => Promise<ArticleRevisionAttempt>;
  readonly recordRound: (round: PersistedArticleReviewRound) => Promise<void>;
  readonly recordSelection: (input: {
    readonly artifactVersionId: string;
    readonly reason: ArticleReviewSelectionReason;
  }) => Promise<void>;
};

export type ArticleReviewSelectionReason =
  | 'passed_all_gates'
  | 'no_changes_needed'
  | 'best_valid_snapshot'
  | 'model_parse_failed'
  | 'deterministic_validation_failed'
  | 'budget_exhausted'
  | 'revision_made_no_changes';

export type ArticleReviewCycleResult = {
  readonly status: 'selected' | 'no_changes_needed' | 'completed_with_degradation';
  readonly selected: ArticleReviewCandidate;
  readonly selectionReason: ArticleReviewSelectionReason;
  readonly rounds: readonly PersistedArticleReviewRound[];
  readonly usage: RuntimeUsage;
  readonly modelCalls: number;
  readonly unresolvedIssues: readonly ArticleReviewIssue[];
};

export class ArticleReviewCycle {
  public constructor(
    private readonly policy: ArticleReviewPolicy,
    private readonly budget: ArticleReviewBudget,
    private readonly port: ArticleReviewCyclePort,
  ) {
    assertBudget(budget);
  }

  public async execute(
    initial: ArticleReviewCandidate,
    signal?: AbortSignal,
  ): Promise<ArticleReviewCycleResult> {
    const rounds: PersistedArticleReviewRound[] = [];
    let usage = emptyUsage();
    let modelCalls = 0;
    let current = initial;

    for (let round = 1; round <= this.budget.maxRevisionRounds + 1; round += 1) {
      const deterministic = reviewArticleDeterministically(current, this.policy);
      if (!deterministic.valid) {
        const assessed = assessment(current, deterministic, undefined, []);
        const persisted = reviewRound(round, assessed, false, false, emptyUsage());
        await this.port.recordRound(persisted);
        rounds.push(persisted);
        return this.finishDegraded(
          rounds,
          usage,
          modelCalls,
          'deterministic_validation_failed',
          deterministic.issues,
          current,
        );
      }

      if (!this.port.review) {
        const assessed = assessment(current, deterministic, 100, []);
        const persisted = reviewRound(round, assessed, true, false, emptyUsage());
        await this.port.recordRound(persisted);
        rounds.push(persisted);
        return this.finish(
          'no_changes_needed',
          current,
          'no_changes_needed',
          rounds,
          usage,
          modelCalls,
          [],
        );
      }

      if (!withinBudget(usage, modelCalls, this.budget)) {
        return this.finishBestDegraded(rounds, usage, modelCalls, 'budget_exhausted', current);
      }
      const modelReview = await this.port.review(current, signal);
      modelCalls += 1;
      usage = addUsage(usage, modelReview.usage);
      if (modelReview.status === 'parse_failed') {
        const assessed = assessment(current, deterministic, undefined, []);
        const persisted = reviewRound(round, assessed, false, true, modelReview.usage);
        await this.port.recordRound(persisted);
        rounds.push(persisted);
        return this.finishDegraded(
          rounds,
          usage,
          modelCalls,
          'model_parse_failed',
          [],
          current,
        );
      }

      const assessed = assessment(current, deterministic, modelReview.score ?? 0, modelReview.issues);
      const persisted = reviewRound(
        round,
        assessed,
        modelReview.passed,
        false,
        modelReview.usage,
      );
      await this.port.recordRound(persisted);
      rounds.push(persisted);
      const issues = [...deterministic.issues, ...modelReview.issues];
      if (
        modelReview.passed &&
        combinedScore(assessed) >= this.budget.passScore &&
        modelReview.issues.every(({ severity }) => severity !== 'error')
      ) {
        return this.finish(
          round === 1 ? 'no_changes_needed' : 'selected',
          current,
          round === 1 ? 'no_changes_needed' : 'passed_all_gates',
          rounds,
          usage,
          modelCalls,
          [],
        );
      }

      if (round > this.budget.maxRevisionRounds || !this.port.revise) {
        return this.finishBestDegraded(rounds, usage, modelCalls, 'best_valid_snapshot', current);
      }
      if (!withinBudget(usage, modelCalls, this.budget)) {
        return this.finishBestDegraded(rounds, usage, modelCalls, 'budget_exhausted', current);
      }
      const revision = await this.port.revise(current, issues, signal);
      modelCalls += 1;
      usage = addUsage(usage, revision.usage);
      if (revision.status === 'no_changes') {
        return this.finishDegraded(
          rounds,
          usage,
          modelCalls,
          'revision_made_no_changes',
          issues,
          current,
        );
      }
      if (
        revision.candidate.artifactId !== initial.artifactId ||
        revision.candidate.version <= current.version
      ) {
        throw new Error('Article reviser must return a newer immutable Artifact Version');
      }
      current = revision.candidate;
    }

    return this.finishBestDegraded(rounds, usage, modelCalls, 'best_valid_snapshot', current);
  }

  private async finishBestDegraded(
    rounds: readonly PersistedArticleReviewRound[],
    usage: RuntimeUsage,
    modelCalls: number,
    reason: ArticleReviewSelectionReason,
    fallback: ArticleReviewCandidate,
  ): Promise<ArticleReviewCycleResult> {
    const best = selectBestValidArticleCandidate(rounds.map(({ candidate }) => candidate));
    const selected = best?.candidate ?? fallback;
    const issues = best
      ? [...best.deterministic.issues, ...best.modelIssues]
      : rounds.at(-1)?.candidate.deterministic.issues ?? [];
    return this.finishDegraded(rounds, usage, modelCalls, reason, issues, selected);
  }

  private async finishDegraded(
    rounds: readonly PersistedArticleReviewRound[],
    usage: RuntimeUsage,
    modelCalls: number,
    reason: ArticleReviewSelectionReason,
    issues: readonly ArticleReviewIssue[],
    selected: ArticleReviewCandidate,
  ): Promise<ArticleReviewCycleResult> {
    return this.finish(
      'completed_with_degradation',
      selected,
      reason,
      rounds,
      usage,
      modelCalls,
      issues,
    );
  }

  private async finish(
    status: ArticleReviewCycleResult['status'],
    selected: ArticleReviewCandidate,
    selectionReason: ArticleReviewSelectionReason,
    rounds: readonly PersistedArticleReviewRound[],
    usage: RuntimeUsage,
    modelCalls: number,
    unresolvedIssues: readonly ArticleReviewIssue[],
  ): Promise<ArticleReviewCycleResult> {
    await this.port.recordSelection({ artifactVersionId: selected.artifactVersionId, reason: selectionReason });
    return {
      status,
      selected,
      selectionReason,
      rounds,
      usage,
      modelCalls,
      unresolvedIssues,
    };
  }
}

function assessment(
  candidate: ArticleReviewCandidate,
  deterministic: ScoredReviewCandidate['deterministic'],
  modelScore: number | undefined,
  modelIssues: readonly ArticleReviewIssue[],
): ScoredReviewCandidate {
  return { candidate, deterministic, ...(modelScore === undefined ? {} : { modelScore }), modelIssues };
}

function reviewRound(
  round: number,
  candidate: ScoredReviewCandidate,
  modelPassed: boolean,
  modelParseFailed: boolean,
  usage: RuntimeUsage,
): PersistedArticleReviewRound {
  return { round, candidate, modelPassed, modelParseFailed, usage };
}

function withinBudget(
  usage: RuntimeUsage,
  modelCalls: number,
  budget: ArticleReviewBudget,
): boolean {
  return (
    modelCalls < budget.maxModelCalls &&
    usage.totalTokens < budget.maxTokens &&
    usage.costUsd < budget.maxCostUsd
  );
}

function assertBudget(budget: ArticleReviewBudget): void {
  if (!Number.isInteger(budget.maxRevisionRounds) || budget.maxRevisionRounds < 0 || budget.maxRevisionRounds > 3) {
    throw new RangeError('Article review revision budget must be an integer between 0 and 3');
  }
  if (!Number.isInteger(budget.maxModelCalls) || budget.maxModelCalls < 1) {
    throw new RangeError('Article review model call budget must be a positive integer');
  }
  if (budget.maxTokens < 1 || budget.maxCostUsd <= 0 || budget.passScore < 0 || budget.passScore > 100) {
    throw new RangeError('Article review token, cost, and score budgets are invalid');
  }
}

function addUsage(left: RuntimeUsage, right: RuntimeUsage): RuntimeUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
  };
}

function emptyUsage(): RuntimeUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

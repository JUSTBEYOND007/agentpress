import { describe, expect, it, vi } from 'vitest';

import {
  ArticleReviewCycle,
  type ArticleReviewCandidate,
  type ArticleReviewCyclePort,
  type ArticleReviewIssue,
} from '../src/index.js';

const emptyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 10,
  costUsd: 0.01,
};
const issue: ArticleReviewIssue = {
  code: 'invalid_document',
  severity: 'warning',
  message: 'Improve structure',
};

describe('ArticleReviewCycle', () => {
  it('returns no_changes_needed when the initial candidate passes every gate', async () => {
    const port = fakePort();
    port.review.mockResolvedValue({
      status: 'reviewed',
      passed: true,
      score: 90,
      issues: [],
      usage: emptyUsage,
    });
    const result = await cycle(port).execute(candidate(1));
    expect(result).toMatchObject({
      status: 'no_changes_needed',
      selectionReason: 'no_changes_needed',
      modelCalls: 1,
    });
    expect(port.revise).not.toHaveBeenCalled();
    expect(port.recordSelection).toHaveBeenCalledWith({
      artifactVersionId: 'version-1',
      reason: 'no_changes_needed',
    });
  });

  it('selects an improved revised candidate and accumulates exact usage', async () => {
    const port = fakePort();
    port.review
      .mockResolvedValueOnce({
        status: 'reviewed',
        passed: false,
        score: 70,
        issues: [issue],
        usage: emptyUsage,
      })
      .mockResolvedValueOnce({
        status: 'reviewed',
        passed: true,
        score: 95,
        issues: [],
        usage: emptyUsage,
      });
    port.revise.mockResolvedValue({
      status: 'revised',
      candidate: candidate(2),
      usage: emptyUsage,
    });
    const result = await cycle(port).execute(candidate(1));
    expect(result).toMatchObject({
      status: 'selected',
      selectionReason: 'passed_all_gates',
      modelCalls: 3,
      usage: { totalTokens: 30, costUsd: 0.03 },
    });
    expect(result.selected.version).toBe(2);
    expect(port.recordRound).toHaveBeenCalledTimes(2);
  });

  it('keeps the best valid prior snapshot after a later degradation', async () => {
    const port = fakePort();
    port.review
      .mockResolvedValueOnce(reviewed(70, [issue]))
      .mockResolvedValueOnce(reviewed(90, [issue]))
      .mockResolvedValueOnce(reviewed(75, [issue]));
    port.revise
      .mockResolvedValueOnce({ status: 'revised', candidate: candidate(2), usage: emptyUsage })
      .mockResolvedValueOnce({ status: 'revised', candidate: candidate(3), usage: emptyUsage });
    const result = await cycle(port, { maxRevisionRounds: 2, maxModelCalls: 5 }).execute(
      candidate(1),
    );
    expect(result).toMatchObject({
      status: 'completed_with_degradation',
      selectionReason: 'best_valid_snapshot',
    });
    expect(result.selected.version).toBe(2);
  });

  it('fails closed on model parse failure without calling the reviser', async () => {
    const port = fakePort();
    port.review.mockResolvedValue({ status: 'parse_failed', usage: emptyUsage });
    const result = await cycle(port).execute(candidate(1));
    expect(result).toMatchObject({
      status: 'completed_with_degradation',
      selectionReason: 'model_parse_failed',
    });
    expect(port.revise).not.toHaveBeenCalled();
    expect(result.rounds[0]).toMatchObject({ modelParseFailed: true });
  });

  it('rejects stale candidates before dispatching model review', async () => {
    const port = fakePort();
    const result = await cycle(port).execute(candidate(1, { baseRevisionId: 'stale' }));
    expect(result).toMatchObject({
      status: 'completed_with_degradation',
      selectionReason: 'deterministic_validation_failed',
    });
    expect(port.review).not.toHaveBeenCalled();
    expect(result.unresolvedIssues[0]?.code).toBe('stale_revision');
  });

  it('stops before another model call when token or call budget is exhausted', async () => {
    const port = fakePort();
    port.review.mockResolvedValue(reviewed(70, [issue]));
    const result = await cycle(port, { maxTokens: 10, maxModelCalls: 3 }).execute(candidate(1));
    expect(result).toMatchObject({
      status: 'completed_with_degradation',
      selectionReason: 'budget_exhausted',
      modelCalls: 1,
    });
    expect(port.revise).not.toHaveBeenCalled();
  });

  it('treats a no-change revision with unresolved issues as degraded', async () => {
    const port = fakePort();
    port.review.mockResolvedValue(reviewed(70, [issue]));
    port.revise.mockResolvedValue({ status: 'no_changes', usage: emptyUsage });
    const result = await cycle(port).execute(candidate(1));
    expect(result).toMatchObject({
      status: 'completed_with_degradation',
      selectionReason: 'revision_made_no_changes',
      modelCalls: 2,
    });
  });
});

function cycle(
  port: ReturnType<typeof fakePort>,
  budget: Partial<ConstructorParameters<typeof ArticleReviewCycle>[1]> = {},
): ArticleReviewCycle {
  return new ArticleReviewCycle(
    {
      currentRevisionId: 'revision-1',
      availableEvidenceIds: new Set(['evidence-1']),
      minCharacters: 5,
      maxCharacters: 1_000,
      maxBlocks: 20,
    },
    {
      maxRevisionRounds: 1,
      maxModelCalls: 3,
      maxTokens: 1_000,
      maxCostUsd: 1,
      passScore: 85,
      ...budget,
    },
    port,
  );
}

function fakePort() {
  return {
    review: vi.fn<NonNullable<ArticleReviewCyclePort['review']>>(),
    revise: vi.fn<NonNullable<ArticleReviewCyclePort['revise']>>(),
    recordRound: vi.fn<ArticleReviewCyclePort['recordRound']>().mockResolvedValue(undefined),
    recordSelection: vi
      .fn<ArticleReviewCyclePort['recordSelection']>()
      .mockResolvedValue(undefined),
  };
}

function reviewed(score: number, issues: readonly ArticleReviewIssue[]) {
  return { status: 'reviewed' as const, passed: false, score, issues, usage: emptyUsage };
}

function candidate(
  version: number,
  overrides: Partial<ArticleReviewCandidate> = {},
): ArticleReviewCandidate {
  return {
    artifactId: 'artifact-1',
    artifactVersionId: `version-${String(version)}`,
    version,
    baseRevisionId: 'revision-1',
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: `block-${String(version)}` },
          content: [{ type: 'text', text: `Candidate article ${String(version)}` }],
        },
      ],
    },
    claims: [{ text: 'Claim', evidenceIds: ['evidence-1'] }],
    evidenceIds: ['evidence-1'],
    summary: `Candidate ${String(version)}`,
    ...overrides,
  };
}

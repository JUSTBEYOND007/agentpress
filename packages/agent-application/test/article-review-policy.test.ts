import { describe, expect, it } from 'vitest';

import {
  reviewArticleDeterministically,
  selectBestValidArticleCandidate,
  type ArticleReviewCandidate,
  type ArticleReviewPolicy,
  type ScoredReviewCandidate,
} from '../src/article-review-policy.js';

const policy: ArticleReviewPolicy = {
  currentRevisionId: 'revision-1',
  availableEvidenceIds: new Set(['evidence-1']),
  minCharacters: 5,
  maxCharacters: 1_000,
  maxBlocks: 20,
};

describe('article review policy', () => {
  it('accepts a structured, evidence-backed article with safe links', () => {
    const result = reviewArticleDeterministically(candidate(1), policy);
    expect(result).toMatchObject({ valid: true, score: 100 });
    expect(result.characterCount).toBeGreaterThan(5);
  });

  it('fails closed for stale revisions, missing Evidence, and unsafe links', () => {
    const input = candidate(1, {
      baseRevisionId: 'revision-old',
      evidenceIds: [],
      document: documentWithText('unsafe content', 'javascript:alert(1)'),
    });
    const result = reviewArticleDeterministically(input, policy);
    expect(result.valid).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual([
      'stale_revision',
      'unsafe_link',
      'missing_evidence',
    ]);
  });

  it('rejects claims without Evidence and malformed article structure', () => {
    const input = candidate(1, {
      claims: [{ text: 'Unsupported fact', evidenceIds: [] }],
      document: {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { blockId: 'duplicate' }, content: [{ text: 'one' }] },
          { type: 'paragraph', attrs: { blockId: 'duplicate' }, content: [{ text: 'two' }] },
        ],
      },
    });
    const result = reviewArticleDeterministically(input, policy);
    expect(result.issues.map(({ code }) => code)).toEqual([
      'duplicate_block_id',
      'claim_without_evidence',
    ]);
  });

  it('keeps an earlier best valid snapshot when a later version degrades', () => {
    const first = scored(candidate(1), 80);
    const improved = scored(candidate(2), 95);
    const degraded = scored(candidate(3), 40);
    expect(selectBestValidArticleCandidate([first, improved, degraded])?.candidate.version).toBe(2);
  });

  it('requires a material three-point improvement before replacing a valid snapshot', () => {
    const first = scored(candidate(1), 90);
    const marginal = scored(candidate(2), 94);
    const material = scored(candidate(3), 98);
    expect(selectBestValidArticleCandidate([first, marginal])?.candidate.version).toBe(1);
    expect(selectBestValidArticleCandidate([first, marginal, material])?.candidate.version).toBe(3);
  });

  it('excludes invalid candidates and uses the earlier version on a score tie', () => {
    const first = scored(candidate(1), 90);
    const tie = scored(candidate(2), 90);
    const invalidCandidate = candidate(3, { baseRevisionId: 'stale' });
    const invalid: ScoredReviewCandidate = {
      candidate: invalidCandidate,
      deterministic: reviewArticleDeterministically(invalidCandidate, policy),
      modelScore: 100,
      modelIssues: [],
    };
    expect(selectBestValidArticleCandidate([first, tie, invalid])?.candidate.version).toBe(1);
  });
});

function candidate(
  version: number,
  overrides: Partial<ArticleReviewCandidate> = {},
): ArticleReviewCandidate {
  return {
    artifactId: 'artifact-1',
    artifactVersionId: `artifact-version-${String(version)}`,
    version,
    baseRevisionId: 'revision-1',
    document: documentWithText('Evidence backed article', 'https://example.com/source'),
    claims: [{ text: 'Evidence backed claim', evidenceIds: ['evidence-1'] }],
    evidenceIds: ['evidence-1'],
    summary: `candidate ${String(version)}`,
    ...overrides,
  };
}

function scored(input: ArticleReviewCandidate, modelScore: number): ScoredReviewCandidate {
  return {
    candidate: input,
    deterministic: reviewArticleDeterministically(input, policy),
    modelScore,
    modelIssues: [],
  };
}

function documentWithText(text: string, href: string): ArticleReviewCandidate['document'] {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { blockId: 'block-1' },
        content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
      },
    ],
  };
}

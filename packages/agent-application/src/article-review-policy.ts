import type { ArticleDocument } from '@agentpress/editor-patch';

export type ArticleReviewIssueCode =
  | 'stale_revision'
  | 'invalid_document'
  | 'duplicate_block_id'
  | 'empty_article'
  | 'article_too_short'
  | 'article_too_long'
  | 'too_many_blocks'
  | 'unsafe_link'
  | 'claim_without_evidence'
  | 'missing_evidence';

export type ArticleReviewIssue = {
  readonly code: ArticleReviewIssueCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly path?: string;
};

export type ArticleClaim = {
  readonly text: string;
  readonly evidenceIds: readonly string[];
};

export type ArticleReviewCandidate = {
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly version: number;
  readonly baseRevisionId: string;
  readonly document: ArticleDocument;
  readonly claims: readonly ArticleClaim[];
  readonly evidenceIds: readonly string[];
  readonly summary: string;
};

export type ArticleReviewPolicy = {
  readonly currentRevisionId: string;
  readonly availableEvidenceIds: ReadonlySet<string>;
  readonly minCharacters: number;
  readonly maxCharacters: number;
  readonly maxBlocks: number;
};

export type DeterministicArticleReview = {
  readonly valid: boolean;
  readonly score: number;
  readonly characterCount: number;
  readonly issues: readonly ArticleReviewIssue[];
};

export type ScoredReviewCandidate = {
  readonly candidate: ArticleReviewCandidate;
  readonly deterministic: DeterministicArticleReview;
  readonly modelScore?: number;
  readonly modelIssues: readonly ArticleReviewIssue[];
};

export function reviewArticleDeterministically(
  candidate: ArticleReviewCandidate,
  policy: ArticleReviewPolicy,
): DeterministicArticleReview {
  const issues: ArticleReviewIssue[] = [];
  if (candidate.baseRevisionId !== policy.currentRevisionId) {
    issues.push(error('stale_revision', 'Article candidate is based on a stale revision'));
  }

  const blocks = candidate.document.content;
  if (blocks.length === 0) {
    issues.push(error('invalid_document', 'Article document must contain at least one block'));
  }
  if (blocks.length > policy.maxBlocks) {
    issues.push(
      error('too_many_blocks', `Article contains ${String(blocks.length)} blocks`, 'document.content'),
    );
  }

  const blockIds = new Set<string>();
  for (const [index, block] of blocks.entries()) {
    const blockId = block.attrs.blockId;
    if (typeof blockId !== 'string' || blockId.length === 0) {
      issues.push(
        error('invalid_document', 'Every article block requires a stable blockId', blockPath(index)),
      );
      continue;
    }
    if (blockIds.has(blockId)) {
      issues.push(
        error('duplicate_block_id', `Duplicate article blockId: ${blockId}`, blockPath(index)),
      );
    }
    blockIds.add(blockId);
  }

  const text = extractText(candidate.document).trim();
  const characterCount = countCharacters(text);
  if (characterCount === 0) {
    issues.push(error('empty_article', 'Article contains no readable text'));
  } else if (characterCount < policy.minCharacters) {
    issues.push(
      error(
        'article_too_short',
        `Article contains ${String(characterCount)} characters; minimum is ${String(policy.minCharacters)}`,
      ),
    );
  }
  if (characterCount > policy.maxCharacters) {
    issues.push(
      error(
        'article_too_long',
        `Article contains ${String(characterCount)} characters; maximum is ${String(policy.maxCharacters)}`,
      ),
    );
  }

  for (const link of collectLinks(candidate.document)) {
    if (!isSafeArticleLink(link.value)) {
      issues.push(error('unsafe_link', `Unsafe article link: ${link.value}`, link.path));
    }
  }

  const candidateEvidence = new Set(candidate.evidenceIds);
  for (const [index, claim] of candidate.claims.entries()) {
    if (claim.evidenceIds.length === 0) {
      issues.push(
        error(
          'claim_without_evidence',
          `Factual claim has no Evidence reference: ${claim.text}`,
          `claims[${String(index)}]`,
        ),
      );
    }
    for (const evidenceId of new Set(claim.evidenceIds)) {
      if (!candidateEvidence.has(evidenceId) || !policy.availableEvidenceIds.has(evidenceId)) {
        issues.push(
          error(
            'missing_evidence',
            `Factual claim references unavailable Evidence: ${evidenceId}`,
            `claims[${String(index)}].evidenceIds`,
          ),
        );
      }
    }
  }

  const score = Math.max(0, 100 - issues.reduce((total, issue) => total + issuePenalty(issue), 0));
  return { valid: issues.every(({ severity }) => severity !== 'error'), score, characterCount, issues };
}

export function selectBestValidArticleCandidate(
  candidates: readonly ScoredReviewCandidate[],
): ScoredReviewCandidate | undefined {
  return candidates
    .filter(({ deterministic, modelIssues }) =>
      deterministic.valid && modelIssues.every(({ severity }) => severity !== 'error'),
    )
    .reduce<ScoredReviewCandidate | undefined>((best, candidate) => {
      if (!best) return candidate;
      const candidateScore = combinedScore(candidate);
      const bestScore = combinedScore(best);
      if (candidateScore >= bestScore + 3) return candidate;
      return best;
    }, undefined);
}

export function combinedScore(candidate: ScoredReviewCandidate): number {
  if (candidate.modelScore === undefined) return candidate.deterministic.score;
  return Math.round(candidate.deterministic.score * 0.6 + clampScore(candidate.modelScore) * 0.4);
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(' ');
  if (!isRecord(value)) return '';
  const ownText = typeof value.text === 'string' ? value.text : '';
  return [ownText, extractText(value.content)].filter(Boolean).join(' ');
}

function countCharacters(value: string): number {
  let count = 0;
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value);
  for (const segment of segments) if (segment.segment) count += 1;
  return count;
}

function collectLinks(value: unknown, path = 'document'): readonly { value: string; path: string }[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectLinks(item, `${path}[${String(index)}]`));
  }
  if (!isRecord(value)) return [];
  const links: { value: string; path: string }[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if ((key === 'href' || key === 'src') && typeof child === 'string') {
      links.push({ value: child, path: childPath });
    } else {
      links.push(...collectLinks(child, childPath));
    }
  }
  return links;
}

function isSafeArticleLink(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('#')) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

function issuePenalty(issue: ArticleReviewIssue): number {
  return issue.severity === 'error' ? 35 : 8;
}

function clampScore(score: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(score) ? score : 0));
}

function error(
  code: ArticleReviewIssueCode,
  message: string,
  path?: string,
): ArticleReviewIssue {
  return { code, severity: 'error', message, ...(path ? { path } : {}) };
}

function blockPath(index: number): string {
  return `document.content[${String(index)}].attrs.blockId`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

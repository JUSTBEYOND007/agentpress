import type { Evidence } from './hybrid-search.js';

export type FaqEntry = {
  readonly id: string;
  readonly workspaceId: string;
  readonly question: string;
  readonly answer: string;
  readonly evidence: readonly Evidence[];
  readonly semanticScore?: number;
  readonly acl: readonly string[];
};

export type FaqMatch = FaqEntry & { readonly confidence: number; readonly match: 'exact' | 'semantic' };

export type FaqSearchResult =
  | { readonly source: 'faq'; readonly match: FaqMatch }
  | { readonly source: 'knowledge'; readonly evidence: readonly Evidence[] }
  | { readonly source: 'unknown'; readonly evidence: readonly Evidence[] };

export function matchFaq(
  query: string,
  entries: readonly FaqEntry[],
  allowedAcl: ReadonlySet<string>,
  semanticThreshold = 0.86,
): FaqMatch | undefined {
  const normalized = normalize(query);
  if (!normalized) return undefined;
  const permitted = entries.filter(
    (entry) => entry.acl.some((principal) => allowedAcl.has(principal)),
  );
  const exact = permitted.find((entry) => normalize(entry.question) === normalized);
  if (exact) return { ...exact, confidence: 1, match: 'exact' };
  const semantic = permitted
    .filter((entry) => (entry.semanticScore ?? 0) >= semanticThreshold)
    .sort(
      (left, right) =>
        (right.semanticScore ?? 0) - (left.semanticScore ?? 0) || left.id.localeCompare(right.id),
    )[0];
  return semantic
    ? { ...semantic, confidence: semantic.semanticScore ?? 0, match: 'semantic' }
    : undefined;
}

export function searchFaqOrKnowledge(input: {
  readonly query: string;
  readonly entries: readonly FaqEntry[];
  readonly allowedAcl: ReadonlySet<string>;
  readonly fallback: () => readonly Evidence[];
  readonly semanticThreshold?: number;
}): FaqSearchResult {
  const match = matchFaq(
    input.query,
    input.entries,
    input.allowedAcl,
    input.semanticThreshold,
  );
  if (match) return { source: 'faq', match };
  const evidence = input.fallback();
  return evidence.length > 0 ? { source: 'knowledge', evidence } : { source: 'unknown', evidence };
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

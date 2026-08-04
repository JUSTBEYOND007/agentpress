export type Evidence = {
  readonly evidenceId: string;
  readonly workspaceId: string;
  readonly source: string;
  readonly chunkId: string;
  readonly revisionHash: string;
  readonly text: string;
  readonly acl: readonly string[];
  readonly retrievalScore: number;
  readonly rerankScore: number;
  readonly importance?: number;
  readonly updatedAt?: string;
};

export type SearchCandidate = Evidence & {
  readonly lexicalScore: number;
  readonly semanticScore: number;
};

export function hybridSearch(
  query: string,
  candidates: readonly SearchCandidate[],
  allowedAcl: ReadonlySet<string>,
  limit = 8,
  options: HybridSearchOptions = {},
): readonly Evidence[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Search limit must be positive');
  const lambda = options.mmrLambda ?? 0.8;
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1)
    throw new RangeError('MMR lambda must be between 0 and 1');
  const terms = tokenize(query);
  const ranked = candidates
    .filter((candidate) => candidate.acl.some((principal) => allowedAcl.has(principal)))
    .map((candidate) => {
      const lexical = lexicalScore(terms, candidate.text);
      const fused =
        0.42 * lexical +
        0.33 * candidate.semanticScore +
        0.2 * candidate.rerankScore +
        0.05 * clamp(candidate.importance ?? 0.5);
      return { candidate, fused: fused * temporalDecay(candidate.updatedAt, options) };
    })
    .sort((left, right) => right.fused - left.fused || left.candidate.chunkId.localeCompare(right.candidate.chunkId));
  const selected: { candidate: SearchCandidate; fused: number }[] = [];
  const remaining = [...ranked];
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const item = remaining[index];
      if (!item) continue;
      const redundancy = selected.reduce(
        (max, chosen) => Math.max(max, tokenOverlap(item.candidate.text, chosen.candidate.text)),
        0,
      );
      const mmr = lambda * item.fused - (1 - lambda) * redundancy;
      if (mmr > bestScore || (mmr === bestScore && item.candidate.chunkId < (remaining[bestIndex]?.candidate.chunkId ?? ''))) {
        bestIndex = index;
        bestScore = mmr;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen) selected.push(chosen);
  }
  return selected.map(({ candidate, fused }) => ({ ...candidate, retrievalScore: fused }));
}

export type HybridSearchOptions = {
  readonly mmrLambda?: number;
  readonly now?: Date;
  readonly temporalHalfLifeMs?: number;
};

function lexicalScore(query: ReadonlySet<string>, text: string): number {
  const terms = tokenize(text);
  if (query.size === 0) return 0;
  return [...query].filter((term) => terms.has(term)).length / query.size;
}

function tokenize(value: string): ReadonlySet<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

function tokenOverlap(left: string, right: string): number {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((term) => b.has(term)).length;
  return intersection / Math.max(a.size, b.size);
}

function temporalDecay(updatedAt: string | undefined, options: HybridSearchOptions): number {
  if (!updatedAt) return 1;
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return 1;
  const halfLife = options.temporalHalfLifeMs ?? 30 * 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(halfLife) || halfLife <= 0) throw new RangeError('Temporal half-life must be positive');
  const age = Math.max(0, (options.now?.getTime() ?? Date.now()) - timestamp);
  return Math.pow(0.5, age / halfLife);
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

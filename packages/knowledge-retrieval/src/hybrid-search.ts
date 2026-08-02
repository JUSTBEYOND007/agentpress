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
): readonly Evidence[] {
  const terms = tokenize(query);
  return candidates
    .filter((candidate) => candidate.acl.some((principal) => allowedAcl.has(principal)))
    .map((candidate) => {
      const lexical = lexicalScore(terms, candidate.text);
      const fused = 0.45 * lexical + 0.35 * candidate.semanticScore + 0.2 * candidate.rerankScore;
      return { candidate, fused };
    })
    .sort(
      (left, right) =>
        right.fused - left.fused || left.candidate.chunkId.localeCompare(right.candidate.chunkId),
    )
    .slice(0, limit)
    .map(({ candidate, fused }) => ({ ...candidate, retrievalScore: fused }));
}

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

export type RetrievalEvalCase = {
  readonly caseId: string;
  readonly scenario?:
    | 'faq_hit'
    | 'knowledge_recall'
    | 'conflicting_sources'
    | 'expired_document'
    | 'no_answer'
    | 'cross_workspace';
  readonly query?: string;
  readonly workspaceId?: string;
  readonly relevantChunkIds: readonly string[];
  readonly rankedChunkIds: readonly string[];
  readonly expectedNoAnswer?: boolean;
  readonly returnedNoAnswer?: boolean;
};

export type RetrievalMetrics = {
  readonly cases: number;
  readonly recallAtK: number;
  readonly mrr: number;
  readonly ndcg: number;
  readonly noAnswerAccuracy: number;
};

export function evaluateRetrieval(cases: readonly RetrievalEvalCase[], k = 5): RetrievalMetrics {
  if (!Number.isSafeInteger(k) || k < 1)
    throw new RangeError('Retrieval evaluation k must be positive');
  if (cases.length === 0) {
    return { cases: 0, recallAtK: 0, mrr: 0, ndcg: 0, noAnswerAccuracy: 0 };
  }
  let recall = 0;
  let reciprocal = 0;
  let ndcg = 0;
  let noAnswerCorrect = 0;
  let noAnswerCases = 0;
  for (const item of cases) {
    const relevant = new Set(item.relevantChunkIds);
    const ranked = item.rankedChunkIds.slice(0, k);
    const hits = ranked.filter((chunkId) => relevant.has(chunkId));
    recall += relevant.size === 0 ? 0 : new Set(hits).size / relevant.size;
    const first = item.rankedChunkIds.findIndex((chunkId) => relevant.has(chunkId));
    reciprocal += first < 0 ? 0 : 1 / (first + 1);
    const dcg = ranked.reduce(
      (sum, chunkId, index) => sum + (relevant.has(chunkId) ? 1 / Math.log2(index + 2) : 0),
      0,
    );
    const ideal = Array.from(
      { length: Math.min(k, relevant.size) },
      (_, index) => 1 / Math.log2(index + 2),
    ).reduce((sum, score) => sum + score, 0);
    ndcg += ideal === 0 ? 0 : dcg / ideal;
    if (item.expectedNoAnswer !== undefined && item.returnedNoAnswer !== undefined) {
      noAnswerCases += 1;
      if (item.expectedNoAnswer === item.returnedNoAnswer) noAnswerCorrect += 1;
    }
  }
  return {
    cases: cases.length,
    recallAtK: recall / cases.length,
    mrr: reciprocal / cases.length,
    ndcg: ndcg / cases.length,
    noAnswerAccuracy: noAnswerCases === 0 ? 0 : noAnswerCorrect / noAnswerCases,
  };
}

export type CitationReference = {
  readonly evidenceId: string;
  readonly workspaceId: string;
  readonly revisionHash: string;
};

export function scoreCitationResolution(
  citations: readonly CitationReference[],
  evidence: readonly CitationReference[],
): { readonly resolved: number; readonly total: number; readonly precision: number } {
  const byId = new Map(evidence.map((item) => [item.evidenceId, item]));
  let resolved = 0;
  for (const citation of citations) {
    const source = byId.get(citation.evidenceId);
    if (
      source?.workspaceId === citation.workspaceId &&
      source.revisionHash === citation.revisionHash
    ) {
      resolved += 1;
    }
  }
  return {
    resolved,
    total: citations.length,
    precision: citations.length === 0 ? 0 : resolved / citations.length,
  };
}

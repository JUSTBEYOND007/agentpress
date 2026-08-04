import {
  evaluateRetrieval,
  scoreCitationResolution,
  type RetrievalCandidate,
  type RetrievalEvalCase,
} from '@agentpress/knowledge-retrieval';

export const RAG_PROVIDER_EVAL_VERSION = '2026-08-04.v1';
export const RAG_PROVIDER_POLICY_VERSION = 'hybrid-provider-eval-v1';

export type RagEvalDocument = {
  readonly chunkId: string;
  readonly workspaceId: string;
  readonly text: string;
  readonly source: string;
  readonly revisionHash: string;
  readonly active: boolean;
};

export type RagProviderEvalCase = {
  readonly caseId: string;
  readonly scenario: NonNullable<RetrievalEvalCase['scenario']>;
  readonly workspaceId: string;
  readonly query: string;
  readonly relevantChunkIds: readonly string[];
  readonly expectedNoAnswer: boolean;
};

export type RagProviderEvalReport = {
  readonly schemaVersion: 1;
  readonly datasetVersion: typeof RAG_PROVIDER_EVAL_VERSION;
  readonly policyVersion: typeof RAG_PROVIDER_POLICY_VERSION;
  readonly provider: string;
  readonly embeddingModel: string;
  readonly rerankModel: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly metrics: ReturnType<typeof evaluateRetrieval> & {
    readonly citationResolution: number;
    readonly crossWorkspaceHits: number;
    readonly errors: number;
  };
  readonly gatesPassed: boolean;
  readonly items: readonly {
    readonly caseId: string;
    readonly scenario: RagProviderEvalCase['scenario'];
    readonly rankedChunkIds: readonly string[];
    readonly returnedNoAnswer: boolean;
    readonly candidateCount: number;
    readonly latencyMs: number;
    readonly error?: string;
  }[];
};

export const ragProviderEvalDocuments: readonly RagEvalDocument[] = [
  document(
    'faq:kafka-recovery',
    'workspace-a',
    'Recover a Kafka consumer by restarting from the committed offset after checking the consumer group lag.',
    'faq://kafka-recovery',
    'faq-r1',
  ),
  document(
    'knowledge:citation-policy:r3',
    'workspace-a',
    'Editorial claims require a resolvable evidence citation with source revision and content hash.',
    'knowledge://citation-policy',
    'citation-r3',
  ),
  document(
    'knowledge:style:r2',
    'workspace-a',
    'News copy uses a concise lead and neutral language.',
    'knowledge://style',
    'style-r2',
  ),
  document(
    'knowledge:deadline:r4',
    'workspace-a',
    'The current publication deadline is Friday at 18:00 UTC.',
    'knowledge://deadline',
    'deadline-r4',
  ),
  {
    ...document(
      'knowledge:deadline:r2',
      'workspace-a',
      'The publication deadline is Thursday at 12:00 UTC.',
      'knowledge://deadline',
      'deadline-r2',
    ),
    active: false,
  },
  {
    ...document(
      'knowledge:embargo:r1',
      'workspace-a',
      'The old embargo ends on Monday.',
      'knowledge://embargo',
      'embargo-r1',
    ),
    active: false,
  },
  document(
    'knowledge:workspace-b-launch',
    'workspace-b',
    'Workspace B private launch notes use the codename Mercury.',
    'knowledge://private-launch',
    'launch-r1',
  ),
  document(
    'knowledge:unrelated:r1',
    'workspace-a',
    'Image captions must include attribution.',
    'knowledge://images',
    'images-r1',
  ),
];

export const ragProviderEvalCases: readonly RagProviderEvalCase[] = [
  evalCase(
    'faq-exact-recovery',
    'faq_hit',
    'How do I recover a Kafka consumer?',
    ['faq:kafka-recovery'],
    false,
  ),
  evalCase(
    'knowledge-semantic-recall',
    'knowledge_recall',
    'What is the editorial citation policy?',
    ['knowledge:citation-policy:r3'],
    false,
  ),
  evalCase(
    'conflict-prefers-current-revision',
    'conflicting_sources',
    'What is the current publication deadline?',
    ['knowledge:deadline:r4'],
    false,
  ),
  evalCase(
    'expired-document-is-not-current-fact',
    'expired_document',
    'Which embargo is active?',
    [],
    true,
  ),
  evalCase(
    'unknown-policy-no-answer',
    'no_answer',
    'What is the policy for an unsupported broadcast channel?',
    [],
    true,
  ),
  evalCase(
    'cross-workspace-result-is-denied',
    'cross_workspace',
    'Show Workspace B private launch notes',
    [],
    true,
  ),
];

export async function runRagProviderEval(input: {
  readonly embed: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;
  readonly rerank: (
    query: string,
    candidates: readonly RetrievalCandidate[],
  ) => Promise<ReadonlyMap<string, number>>;
  readonly embeddingModel: string;
  readonly rerankModel: string;
  readonly provider?: string;
  readonly cases?: readonly RagProviderEvalCase[];
  readonly documents?: readonly RagEvalDocument[];
  readonly limit?: number;
  readonly noAnswerThreshold?: number;
  readonly now?: () => Date;
}): Promise<RagProviderEvalReport> {
  const cases = input.cases ?? ragProviderEvalCases;
  const documents = input.documents ?? ragProviderEvalDocuments;
  const limit = input.limit ?? 5;
  const threshold = input.noAnswerThreshold ?? 0.5;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError('RAG eval limit must be positive');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('RAG eval no-answer threshold must be between zero and one');
  }
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const items = [];
  for (const item of cases) {
    const started = performance.now();
    const candidates = documents.filter(
      (document_) => document_.workspaceId === item.workspaceId && document_.active,
    );
    try {
      const vectors = await input.embed([item.query, ...candidates.map(({ text }) => text)]);
      const queryVector = vectors[0];
      if (!queryVector || vectors.length !== candidates.length + 1) {
        throw new Error('Embedding provider returned an incomplete batch');
      }
      const retrievalCandidates = candidates
        .map((document_, index) =>
          toRetrievalCandidate(document_, cosine(queryVector, vectors[index + 1])),
        )
        .sort((left, right) => right.semanticDistance - left.semanticDistance)
        .slice(0, Math.max(limit * 4, limit));
      const reranked = await input.rerank(item.query, retrievalCandidates);
      const ranked = retrievalCandidates
        .map((candidate) => ({ candidate, score: reranked.get(candidate.chunkId) ?? 0 }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.candidate.chunkId.localeCompare(right.candidate.chunkId),
        );
      const topScore = ranked[0]?.score ?? 0;
      const returnedNoAnswer = topScore < threshold;
      items.push({
        caseId: item.caseId,
        scenario: item.scenario,
        rankedChunkIds: returnedNoAnswer
          ? []
          : ranked.slice(0, limit).map(({ candidate }) => candidate.chunkId),
        returnedNoAnswer,
        candidateCount: retrievalCandidates.length,
        latencyMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      items.push({
        caseId: item.caseId,
        scenario: item.scenario,
        rankedChunkIds: [],
        returnedNoAnswer: false,
        candidateCount: candidates.length,
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : 'Unknown RAG provider eval error',
      });
    }
  }
  const retrievalCases = items.map((item, index) => ({
    caseId: item.caseId,
    scenario: item.scenario,
    relevantChunkIds: cases[index]?.relevantChunkIds ?? [],
    rankedChunkIds: item.rankedChunkIds,
    expectedNoAnswer: cases[index]?.expectedNoAnswer ?? false,
    returnedNoAnswer: item.returnedNoAnswer,
  }));
  const answerableRetrieval = evaluateRetrieval(
    retrievalCases.filter(({ relevantChunkIds }) => relevantChunkIds.length > 0),
    limit,
  );
  const noAnswerAccuracy = evaluateRetrieval(retrievalCases, limit).noAnswerAccuracy;
  const crossWorkspaceHits = items.reduce(
    (total, item, index) =>
      total +
      item.rankedChunkIds.filter(
        (chunkId) =>
          documents.find((document_) => document_.chunkId === chunkId)?.workspaceId !==
          cases[index]?.workspaceId,
      ).length,
    0,
  );
  const citations = items.flatMap((item) =>
    item.rankedChunkIds.map((chunkId) => citation(documents, chunkId)),
  );
  const citationScore = scoreCitationResolution(
    citations,
    documents.map((document_) => ({
      evidenceId: document_.chunkId,
      workspaceId: document_.workspaceId,
      revisionHash: document_.revisionHash,
    })),
  );
  const errors = items.filter(({ error }) => error !== undefined).length;
  const metrics = {
    ...answerableRetrieval,
    cases: retrievalCases.length,
    noAnswerAccuracy,
    citationResolution: citationScore.precision,
    crossWorkspaceHits,
    errors,
  };
  return {
    schemaVersion: 1,
    datasetVersion: RAG_PROVIDER_EVAL_VERSION,
    policyVersion: RAG_PROVIDER_POLICY_VERSION,
    provider: input.provider ?? 'unknown',
    embeddingModel: input.embeddingModel,
    rerankModel: input.rerankModel,
    startedAt,
    completedAt: now().toISOString(),
    metrics,
    gatesPassed:
      metrics.recallAtK >= 0.9 &&
      metrics.mrr >= 0.8 &&
      metrics.ndcg >= 0.85 &&
      metrics.citationResolution === 1 &&
      metrics.noAnswerAccuracy === 1 &&
      metrics.crossWorkspaceHits === 0 &&
      metrics.errors === 0,
    items,
  };
}

function document(
  chunkId: string,
  workspaceId: string,
  text: string,
  source: string,
  revisionHash: string,
): RagEvalDocument {
  return { chunkId, workspaceId, text, source, revisionHash, active: true };
}

function evalCase(
  caseId: string,
  scenario: RagProviderEvalCase['scenario'],
  query: string,
  relevantChunkIds: readonly string[],
  expectedNoAnswer: boolean,
): RagProviderEvalCase {
  return {
    caseId,
    scenario,
    workspaceId: 'workspace-a',
    query,
    relevantChunkIds,
    expectedNoAnswer,
  };
}

function toRetrievalCandidate(document_: RagEvalDocument, similarity: number): RetrievalCandidate {
  return {
    evidenceId: document_.chunkId,
    workspaceId: document_.workspaceId,
    source: document_.source,
    chunkId: document_.chunkId,
    revisionHash: document_.revisionHash,
    text: document_.text,
    acl: ['workspace:members'],
    lexicalRank: 0,
    semanticDistance: similarity,
  };
}

function cosine(left: readonly number[], right: readonly number[] | undefined): number {
  if (!right || left.length === 0 || left.length !== right.length)
    throw new Error('Embedding vectors have incompatible dimensions');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function citation(documents: readonly RagEvalDocument[], chunkId: string) {
  const document_ = documents.find((candidate) => candidate.chunkId === chunkId);
  if (!document_) throw new Error(`RAG eval result references unknown chunk ${chunkId}`);
  return {
    evidenceId: chunkId,
    workspaceId: document_.workspaceId,
    revisionHash: document_.revisionHash,
  };
}

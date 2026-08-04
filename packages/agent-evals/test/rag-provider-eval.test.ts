import type { RetrievalCandidate } from '@agentpress/knowledge-retrieval';
import { describe, expect, it } from 'vitest';

import { ragProviderEvalCases, runRagProviderEval } from '../src/rag-provider-eval.js';

describe('target-provider RAG evaluation', () => {
  it('scores ranking, no-answer, citations and workspace isolation together', async () => {
    const report = await runRagProviderEval({
      embed: (texts) => Promise.resolve(texts.map(vectorForText)),
      rerank: (query, candidates) => Promise.resolve(rerank(query, candidates)),
      provider: 'provider-under-test',
      embeddingModel: 'embedding-under-test',
      rerankModel: 'rerank-under-test',
    });

    expect(report.metrics).toMatchObject({
      cases: ragProviderEvalCases.length,
      recallAtK: 1,
      mrr: 1,
      ndcg: 1,
      noAnswerAccuracy: 1,
      citationResolution: 1,
      crossWorkspaceHits: 0,
      errors: 0,
    });
    expect(report.provider).toBe('provider-under-test');
    expect(report.gatesPassed).toBe(true);
    expect(report.items.find(({ scenario }) => scenario === 'cross_workspace')).toMatchObject({
      rankedChunkIds: [],
      returnedNoAnswer: true,
    });
  });

  it('fails closed when a provider errors', async () => {
    const firstCase = ragProviderEvalCases[0];
    if (!firstCase) throw new Error('RAG provider eval fixture is empty');
    const report = await runRagProviderEval({
      embed: () => Promise.reject(new Error('provider unavailable')),
      rerank: () => Promise.resolve(new Map()),
      embeddingModel: 'embedding-under-test',
      rerankModel: 'rerank-under-test',
      cases: [firstCase],
    });

    expect(report.metrics.errors).toBe(1);
    expect(report.gatesPassed).toBe(false);
    expect(report.items[0]?.error).toBe('provider unavailable');
  });
});

function vectorForText(text: string): readonly number[] {
  const value = text.toLowerCase();
  return [
    Number(/kafka|consumer/u.test(value)),
    Number(/citation|evidence/u.test(value)),
    Number(/deadline|friday/u.test(value)),
    Number(value.includes('embargo')),
    Number(/broadcast|unsupported/u.test(value)),
    Number(/workspace b|private launch/u.test(value)),
    0.01,
  ];
}

function rerank(
  query: string,
  candidates: readonly RetrievalCandidate[],
): ReadonlyMap<string, number> {
  const queryVector = vectorForText(query);
  return new Map(
    candidates.map((candidate) => {
      const candidateVector = vectorForText(candidate.text);
      const overlap = queryVector
        .slice(0, 6)
        .reduce((sum, value, index) => sum + value * (candidateVector[index] ?? 0), 0);
      return [candidate.chunkId, overlap > 0 ? 0.99 : 0.1];
    }),
  );
}

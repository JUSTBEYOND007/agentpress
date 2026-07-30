import type { RetrievalCandidate } from './postgres-hybrid-search.js';

export class ArkRerankProvider {
  public constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly model: string;
    },
  ) {}

  public async rerank(
    query: string,
    candidates: readonly RetrievalCandidate[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, number>> {
    if (candidates.length === 0) return new Map();
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/u, '')}/rerank`, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        query,
        documents: candidates.map((candidate) => candidate.text),
        top_n: candidates.length,
      }),
    });
    if (!response.ok) throw new Error(`Ark rerank request failed (${String(response.status)})`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.results))
      throw new Error('Ark rerank response is invalid');
    const scores = new Map<string, number>();
    for (const result of payload.results) {
      if (
        !isRecord(result) ||
        typeof result.index !== 'number' ||
        !Number.isSafeInteger(result.index) ||
        typeof result.relevance_score !== 'number'
      )
        throw new Error('Ark rerank result is invalid');
      const candidate = candidates[result.index];
      if (!candidate) throw new Error('Ark rerank result references an unknown document');
      scores.set(candidate.chunkId, result.relevance_score);
    }
    return scores;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

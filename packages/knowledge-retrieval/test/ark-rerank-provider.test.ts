import { describe, expect, it, vi } from 'vitest';
import { ArkRerankProvider, type RetrievalCandidate } from '../src/index.js';

describe('ArkRerankProvider', () => {
  it('maps provider document indexes back to stable chunk ids', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              { index: 1, relevance_score: 0.91 },
              { index: 0, relevance_score: 0.42 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const candidates = [candidate('chunk-a', 'Alpha'), candidate('chunk-b', 'Beta')];
    const scores = await new ArkRerankProvider({
      apiKey: 'secret',
      baseUrl: 'https://ark.example/v3/',
      model: 'rerank-model',
    }).rerank('query', candidates);
    expect(scores).toEqual(
      new Map([
        ['chunk-b', 0.91],
        ['chunk-a', 0.42],
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ark.example/v3/rerank',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });
});

function candidate(chunkId: string, text: string): RetrievalCandidate {
  return {
    evidenceId: `evidence:${chunkId}`,
    workspaceId: 'workspace',
    source: 'article:one',
    chunkId,
    revisionHash: 'revision',
    text,
    acl: ['workspace:members'],
    lexicalRank: 1,
    semanticDistance: 0.1,
  };
}

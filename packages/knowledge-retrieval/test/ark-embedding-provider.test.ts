import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from '@agentpress/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArkEmbeddingProvider } from '../src/index.js';

describe('ArkEmbeddingProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the current multimodal embedding contract and preserves input order', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const body = parseRequestBody(init?.body) as {
        input: [{ text: string }];
      };
      const marker = body.input[0].text === 'first' ? 1 : 2;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              embedding: Array.from({ length: KNOWLEDGE_EMBEDDING_DIMENSIONS }, () => marker),
            },
          }),
          { status: 200 },
        ),
      );
    });
    const provider = new ArkEmbeddingProvider({
      apiKey: 'secret',
      baseUrl: 'https://ark.example/v3',
      model: 'embedding-model',
    });

    const vectors = await provider.embed(['first', 'second']);
    expect(vectors).toHaveLength(2);
    expect(vectors.map((vector) => vector.length)).toEqual([
      KNOWLEDGE_EMBEDDING_DIMENSIONS,
      KNOWLEDGE_EMBEDDING_DIMENSIONS,
    ]);
    expect(vectors.map((vector) => vector[0])).toEqual([1, 2]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://ark.example/v3/embeddings/multimodal',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = parseRequestBody(request.mock.calls[0]?.[1]?.body);
    expect(body).toMatchObject({
      model: 'embedding-model',
      dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
      encoding_format: 'float',
      input: [{ type: 'text', text: 'first' }],
    });
  });

  it('rejects vectors that do not match the database dimension', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { embedding: [1, 2, 3] } }), { status: 200 }),
    );
    const provider = new ArkEmbeddingProvider({
      apiKey: 'secret',
      baseUrl: 'https://ark.example/v3',
      model: 'embedding-model',
    });

    await expect(provider.embed(['text'])).rejects.toThrow('1024-dimensional');
  });
});

function parseRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') throw new TypeError('Expected a JSON request body');
  return JSON.parse(body) as Record<string, unknown>;
}

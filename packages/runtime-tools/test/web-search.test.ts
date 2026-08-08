import { describe, expect, it, vi } from 'vitest';

import { PublicSearchError, searchPublicSources } from '../src/web-search.js';

describe('public web search', () => {
  it('adapts an anonymous AnySearch request to bounded public results', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        code: 0,
        data: {
          results: [
            {
              title: 'KIP-429',
              url: 'https://cwiki.apache.org/kafka/KIP-429',
              snippet: 'Incremental cooperative rebalancing',
              content: 'not projected by the search adapter',
            },
          ],
          metadata: {},
        },
      }),
    );

    await expect(
      searchPublicSources('Kafka cooperative rebalance', 3, { fetch: request }),
    ).resolves.toEqual([
      {
        title: 'KIP-429',
        url: 'https://cwiki.apache.org/kafka/KIP-429',
        excerpt: 'Incremental cooperative rebalancing',
        source: 'AnySearch',
      },
    ]);
    expect(request).toHaveBeenCalledWith(
      'https://api.anysearch.com/v1/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'Kafka cooperative rebalance', max_results: 3 }),
      }),
    );
    expect(new Headers(request.mock.calls[0]?.[1]?.headers)).toEqual(
      new Headers({ 'content-type': 'application/json' }),
    );
  });

  it('returns an explicit empty result set without inventing sources', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 0, data: { results: [], metadata: {} } }));
    await expect(searchPublicSources('unknown', 5, { fetch: request })).resolves.toEqual([]);
  });

  it('fails loudly for malformed provider envelopes', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 0, data: { results: [] } }));
    await expect(searchPublicSources('malformed', 5, { fetch: request })).rejects.toThrow(
      'AnySearch API returned invalid response: expected data.metadata object',
    );
  });

  it('sends an optional credential without retaining provider error bodies', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            'provider exposed username=generated password=generated api_key=secret-key',
            { status: 401 },
          ),
        ),
      );
    await expect(
      searchPublicSources('keyed', 5, { fetch: request, apiKey: 'secret-key' }),
    ).rejects.toMatchObject({ name: 'PublicSearchError', kind: 'search_failed' });
    await expect(
      searchPublicSources('keyed', 5, { fetch: request, apiKey: 'secret-key' }),
    ).rejects.not.toThrow(/secret-key|generated|password/u);
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer secret-key',
    );
  });

  it('propagates caller cancellation to the provider request', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      expect(init?.signal?.aborted).toBe(true);
      return Promise.reject(init?.signal?.reason);
    });
    await expect(
      searchPublicSources('cancelled', 5, { fetch: request, signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();
  });

  it('keeps timeout, rate limit, and provider Schema failures distinct', async () => {
    const hanging = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    await expect(
      searchPublicSources('timeout', 5, { fetch: hanging, timeoutMs: 1 }),
    ).rejects.toMatchObject({ name: 'PublicSearchError', kind: 'search_timeout' });
    await expect(
      searchPublicSources('limited', 5, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 })),
      }),
    ).rejects.toMatchObject({ name: 'PublicSearchError', kind: 'rate_limited' });
    await expect(
      searchPublicSources('schema', 5, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 0, data: {} })),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PublicSearchError>>({
        name: 'PublicSearchError',
        kind: 'provider_schema_invalid',
      }),
    );
  });
});

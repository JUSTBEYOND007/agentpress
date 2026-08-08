import { describe, expect, it, vi } from 'vitest';

import { executeWebResearchSearch } from '../src/web-research-handler.js';
import { PublicSearchError } from '../src/web-search.js';

describe('web research execution handler', () => {
  it('returns a typed claim-free failure envelope when search fails', async () => {
    const result = await executeWebResearchSearch(
      { query: 'topic', limit: 2, signal: new AbortController().signal },
      {
        search: vi.fn(() =>
          Promise.reject(new PublicSearchError('rate_limited', 'Provider throttled the request')),
        ),
      },
    );
    expect(result).toEqual({
      results: [],
      failures: [{ kind: 'rate_limited', detail: 'Provider throttled the request' }],
    });
  });

  it('preserves successful sources alongside a typed partial fetch failure', async () => {
    const result = await executeWebResearchSearch(
      { query: 'topic', limit: 2, signal: new AbortController().signal },
      {
        search: vi.fn(() =>
          Promise.resolve([
            { title: 'A', url: 'https://a.test', excerpt: 'A excerpt', source: 'test' },
            { title: 'B', url: 'https://b.test', excerpt: 'B excerpt', source: 'test' },
          ]),
        ),
        fetchSource: vi.fn((url) =>
          url === 'https://a.test'
            ? Promise.resolve({
                url,
                finalUrl: url,
                title: 'Fetched A',
                text: 'Verified source A',
                contentType: 'text/html',
                fetchedAt: '2026-08-08T00:00:00.000Z',
              })
            : Promise.reject(new Error('fetch timed out')),
        ),
      },
    );
    expect(result.results).toContainEqual(
      expect.objectContaining({ url: 'https://a.test', text: 'Verified source A' }),
    );
    expect(result.failures).toEqual([
      { kind: 'fetch_failed', detail: 'fetch timed out', url: 'https://b.test' },
    ]);
  });

  it('returns only successful sources and marks an all-source failure', async () => {
    const result = await executeWebResearchSearch(
      { query: 'topic', limit: 2, signal: new AbortController().signal },
      {
        search: vi.fn(() =>
          Promise.resolve([
            { title: 'A', url: 'https://a.test', excerpt: 'A excerpt', source: 'test' },
            { title: 'B', url: 'https://b.test', excerpt: 'B excerpt', source: 'test' },
          ]),
        ),
        fetchSource: vi.fn(() => Promise.reject(new Error('source unavailable'))),
      },
    );
    expect(result.results).toEqual([]);
    expect(result.failures).toEqual([
      { kind: 'fetch_failed', detail: 'source unavailable', url: 'https://a.test' },
      { kind: 'fetch_failed', detail: 'source unavailable', url: 'https://b.test' },
      { kind: 'all_sources_failed', detail: 'All fetched research sources failed' },
    ]);
  });

  it('preserves caller cancellation instead of degrading it into a fetch failure', async () => {
    const controller = new AbortController();
    const cancellation = new Error('cancelled by caller');
    const search = vi.fn(() =>
      Promise.resolve([{ title: 'A', url: 'https://a.test', excerpt: '', source: 'test' }]),
    );
    const fetchSource = vi.fn(async () => {
      controller.abort(cancellation);
      throw cancellation;
    });
    await expect(
      executeWebResearchSearch(
        { query: 'topic', limit: 1, signal: controller.signal },
        { search, fetchSource },
      ),
    ).rejects.toBe(cancellation);
  });
});

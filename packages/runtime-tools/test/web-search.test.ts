import { describe, expect, it, vi } from 'vitest';

import { searchPublicSources } from '../src/web-search.js';

describe('public web search', () => {
  it('merges current news and encyclopedia results without semantic routing', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      if (url.includes('news.google.com')) {
        return Promise.resolve(
          new Response(
            `<?xml version="1.0"?><rss><channel><item><title>Model release</title><link>https://news.google.com/articles/1</link><pubDate>Thu, 30 Jul 2026 08:00:00 GMT</pubDate><source>Example News</source><description><![CDATA[Current report]]></description></item></channel></rss>`,
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          query: {
            search: [
              { title: 'Artificial intelligence', pageid: 42, snippet: '<b>Background</b>' },
            ],
          },
        }),
      );
    });

    await expect(searchPublicSources('AI', 5, { fetch: request })).resolves.toEqual([
      expect.objectContaining({ title: 'Model release', source: 'Example News' }),
      expect.objectContaining({ title: 'Artificial intelligence', source: 'Wikipedia' }),
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps results when one provider is unavailable', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).includes('news.google.com')) return Promise.reject(new Error('offline'));
      return Promise.resolve(
        Response.json({
          query: { search: [{ title: 'Kafka', pageid: 7, snippet: 'event streaming' }] },
        }),
      );
    });

    await expect(searchPublicSources('Kafka', 5, { fetch: request })).resolves.toHaveLength(1);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { assertSafeUrl, fetchPublicImage, fetchResearchSource } from '../src/index.js';

const publicLookup = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '[::1]',
    '[::ffff:127.0.0.1]',
  ])('blocks reserved literal %s', async (host) => {
    await expect(assertSafeUrl(`http://${host}/`)).rejects.toThrow(/blocked|Blocked/);
  });

  it('blocks any private answer in a mixed DNS response', async () => {
    await expect(
      assertSafeUrl('https://example.test', {
        lookup: () =>
          Promise.resolve([
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.1', family: 4 },
          ]),
      }),
    ).rejects.toThrow(/Blocked/);
  });

  it('permits public targets and rejects schemes and credentials', async () => {
    await expect(
      assertSafeUrl('https://example.test', { lookup: publicLookup }),
    ).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(/HTTP/);
    await expect(assertSafeUrl('https://user:pass@example.com')).rejects.toThrow(/credentials/);
  });

  it('validates every redirect before fetching it', async () => {
    const request = vi.fn(() =>
      Promise.resolve(
        new Response('', { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
      ),
    );
    await expect(
      fetchResearchSource('https://example.test', { lookup: publicLookup, fetch: request }),
    ).rejects.toThrow(/Blocked/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds redirects, media types and response size', async () => {
    const redirect = () =>
      Promise.resolve(new Response('', { status: 302, headers: { location: '/again' } }));
    await expect(
      fetchResearchSource('https://example.test', {
        lookup: publicLookup,
        fetch: redirect,
        maxRedirects: 1,
      }),
    ).rejects.toThrow(/too long/);
    await expect(
      fetchResearchSource('https://example.test', {
        lookup: publicLookup,
        fetch: () =>
          Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })),
      }),
    ).rejects.toThrow(/content type/);
    await expect(
      fetchResearchSource('https://example.test', {
        lookup: publicLookup,
        fetch: () =>
          Promise.resolve(
            new Response('large', {
              headers: { 'content-type': 'text/plain', 'content-length': '100' },
            }),
          ),
        maxBytes: 10,
      }),
    ).rejects.toThrow(/exceeds/);
  });

  it('downloads only bounded public image media', async () => {
    await expect(
      fetchPublicImage('https://example.test/image.png', {
        lookup: publicLookup,
        fetch: () =>
          Promise.resolve(
            new Response(new Uint8Array([1, 2, 3]), {
              headers: { 'content-type': 'image/png' },
            }),
          ),
      }),
    ).resolves.toMatchObject({ mimeType: 'image/png', finalUrl: 'https://example.test/image.png' });
    await expect(
      fetchPublicImage('https://example.test/image.svg', {
        lookup: publicLookup,
        fetch: () =>
          Promise.resolve(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })),
      }),
    ).rejects.toThrow(/Unsupported image/);
  });

  it('rejects a response claiming to be a PDF without a PDF signature', async () => {
    await expect(
      fetchResearchSource('https://example.test/report.pdf', {
        lookup: publicLookup,
        fetch: () =>
          Promise.resolve(
            new Response('not a pdf', { headers: { 'content-type': 'application/pdf' } }),
          ),
      }),
    ).rejects.toThrow(/signature/);
  });

  it('extracts HTML through a parser and excludes executable nodes', async () => {
    await expect(
      fetchResearchSource('https://example.test/article', {
        lookup: publicLookup,
        fetch: () =>
          Promise.resolve(
            new Response(
              '<html><head><title>A &amp; B</title><style>hidden-style</style></head><body><p>Visible <strong>text</strong>.</p><script>hidden-script</script></body></html>',
              { headers: { 'content-type': 'text/html' } },
            ),
          ),
      }),
    ).resolves.toMatchObject({ title: 'A & B', text: 'A & B Visible text .' });
  });
});

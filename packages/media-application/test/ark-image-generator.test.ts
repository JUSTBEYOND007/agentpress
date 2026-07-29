import { describe, expect, it, vi } from 'vitest';

import { ArkImageGenerator } from '../src/index.js';

describe('ArkImageGenerator', () => {
  it('uses the real provider contract and bounds downloaded image media', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ url: 'https://images.example/generated.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '4' },
        }),
      );
    const generator = new ArkImageGenerator({
      apiKey: 'secret',
      baseUrl: 'https://ark.example/v3',
      model: 'image-model',
      fetch: request,
    });

    await expect(generator.generate('editorial illustration')).resolves.toMatchObject({
      mimeType: 'image/png',
      model: 'image-model',
      sourceUrl: 'https://images.example/generated.png',
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://ark.example/v3/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

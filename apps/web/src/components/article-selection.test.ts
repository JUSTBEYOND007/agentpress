import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalArticleJson, hashArticleSelectionBlock } from './article-selection';

describe('article selection hashing', () => {
  it('matches the server canonical SHA-256 block hash', async () => {
    const block = {
      type: 'paragraph',
      attrs: { level: null, blockId: 'block-1' },
      content: [{ marks: [{ type: 'bold' }], text: 'Selected text', type: 'text' }],
    };
    const serverEquivalent = createHash('sha256').update(canonicalArticleJson(block)).digest('hex');

    await expect(hashArticleSelectionBlock(block)).resolves.toBe(serverEquivalent);
  });

  it('is stable when object keys arrive in a different order', () => {
    expect(canonicalArticleJson({ type: 'paragraph', attrs: { z: 1, a: 2 } })).toBe(
      canonicalArticleJson({ attrs: { a: 2, z: 1 }, type: 'paragraph' }),
    );
  });
});

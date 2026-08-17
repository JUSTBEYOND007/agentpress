import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalArticleJson,
  hashArticleSelectionBlock,
  selectionForActiveArticle,
  type ArticleSelectionView,
} from './article-selection';

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

describe('article selection boundary', () => {
  const selection: ArticleSelectionView = {
    articleId: 'article-1',
    revisionId: 'revision-1',
    preview: 'Selected paragraph',
    blocks: [{ blockId: 'block-1', contentHash: 'hash-1' }],
  };

  it('keeps a selection only for its active article', () => {
    expect(selectionForActiveArticle(selection, 'article-1')).toBe(selection);
    expect(selectionForActiveArticle(selection, 'article-2')).toBeUndefined();
    expect(selectionForActiveArticle(selection, undefined)).toBeUndefined();
  });
});

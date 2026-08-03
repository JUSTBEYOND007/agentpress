import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ArticleReviewToolbar } from './article-review-toolbar';
import type { ArticleReviewState } from './article-review';

describe('ArticleReviewToolbar', () => {
  it('presents a document proposal as one reviewable change with reload action', () => {
    const review: ArticleReviewState = {
      proposal: {
        proposalId: 'proposal-1',
        status: 'pending',
        reviewMode: 'document',
        operations: [
          {
            operationId: 'operation-1',
            kind: 'replace',
            blockId: 'block-1',
            expectedHash: 'hash-1',
            block: { type: 'paragraph', attrs: { blockId: 'block-1' }, content: [] },
          },
          {
            operationId: 'operation-2',
            kind: 'insert',
            afterBlockId: 'block-1',
            block: { type: 'paragraph', attrs: { blockId: 'block-2' }, content: [] },
          },
        ],
        diffs: [],
      },
      decisions: {},
      visible: true,
      phase: 'conflict',
      error: '正文已更新',
      onDecision: vi.fn(),
      onReload: vi.fn(),
    };
    const markup = renderToStaticMarkup(
      <ArticleReviewToolbar
        activeIndex={0}
        onDecisionAll={vi.fn()}
        onMove={vi.fn()}
        onVisibleChange={vi.fn()}
        review={review}
      />,
    );
    expect(markup).toContain('1 个整体变更');
    expect(markup).toContain('重新加载最新正文');
    expect(markup).not.toContain('1/2');
  });
});

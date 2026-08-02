import { describe, expect, it, vi } from 'vitest';

import { createArticleReviewState } from './article-review';

describe('article review state', () => {
  it('binds the live decision callback when a proposal becomes visible', () => {
    const onDecision = vi.fn();
    const review = createArticleReviewState(
      {
        proposalId: 'proposal-1',
        status: 'pending',
        operations: [
          {
            operationId: 'operation-1',
            kind: 'delete',
            blockId: 'block-1',
            expectedHash: 'hash',
          },
        ],
        diffs: [],
      },
      onDecision,
    );

    review.onDecision('operation-1', 'accepted');

    expect(onDecision).toHaveBeenCalledWith('operation-1', 'accepted');
  });
});

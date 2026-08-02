import { describe, expect, it } from 'vitest';
import { comparePendingAutosaves, type PendingAutosave } from './autosave-queue';

describe('pending autosave ordering', () => {
  it('preserves transaction order when several edits share a timestamp', () => {
    const batches: PendingAutosave[] = [
      pending('random-a', 3),
      pending('random-z', 1),
      pending('random-m', 2),
    ];

    expect(batches.sort(comparePendingAutosaves).map((batch) => batch.clientSequence)).toEqual([
      1, 2, 3,
    ]);
  });
});

function pending(updateId: string, clientSequence: number): PendingAutosave {
  return {
    updateId,
    articleId: 'article-1',
    steps: [{ stepType: 'replace' }],
    createdAt: 1_700_000_000_000,
    clientSequence,
  };
}

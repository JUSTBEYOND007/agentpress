import { describe, expect, it } from 'vitest';

import {
  planConversationCompaction,
  resolveCompactionBudget,
  shouldCompactConversation,
} from '../src/conversation-compaction-policy.js';

describe('conversation compaction policy', () => {
  it('keeps reserve provenance and recovers impossible default reserves proportionally', () => {
    expect(resolveCompactionBudget(8_000)).toEqual({
      reserveTokens: 1_200,
      provenance: 'proportional',
    });
    expect(resolveCompactionBudget(128_000)).toEqual({
      reserveTokens: 19_200,
      provenance: 'default',
    });
    expect(resolveCompactionBudget(8_000, 7_000)).toEqual({
      reserveTokens: 7_000,
      provenance: 'explicit',
    });
  });

  it('triggers only after the resolved threshold is exceeded', () => {
    const budget = resolveCompactionBudget(10_000, 2_000);
    expect(shouldCompactConversation(8_000, 10_000, budget)).toBe(false);
    expect(shouldCompactConversation(8_001, 10_000, budget)).toBe(true);
  });

  it('keeps complete recent turns and continues from the previous keep boundary', () => {
    const messages = [
      { sequence: 1, role: 'user' as const, tokenCount: 50 },
      { sequence: 2, role: 'assistant' as const, tokenCount: 100 },
      { sequence: 3, role: 'user' as const, tokenCount: 60 },
      { sequence: 4, role: 'assistant' as const, tokenCount: 120 },
      { sequence: 5, role: 'user' as const, tokenCount: 70 },
      { sequence: 6, role: 'assistant' as const, tokenCount: 130 },
    ];

    expect(
      planConversationCompaction({ messages, sourceFromSequence: 1, keepRecentTokens: 250 }),
    ).toEqual({
      sourceFromSequence: 1,
      sourceThroughSequence: 2,
      firstKeptMessageSequence: 3,
      tokensBefore: 530,
      keptTokens: 380,
    });
    expect(
      planConversationCompaction({ messages, sourceFromSequence: 3, keepRecentTokens: 190 }),
    ).toMatchObject({
      sourceFromSequence: 3,
      sourceThroughSequence: 4,
      firstKeptMessageSequence: 5,
    });
  });

  it('does not manufacture a cut when there is no complete older turn to summarize', () => {
    expect(
      planConversationCompaction({
        messages: [
          { sequence: 1, role: 'user', tokenCount: 100 },
          { sequence: 2, role: 'assistant', tokenCount: 100 },
        ],
        sourceFromSequence: 1,
        keepRecentTokens: 200,
      }),
    ).toBeUndefined();
  });
});

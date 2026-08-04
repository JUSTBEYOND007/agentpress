import { describe, expect, it } from 'vitest';

import {
  planConversationCompaction,
  planRuntimeCompaction,
  resolveCompactionKeepTokens,
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

  it('matches the pinned official Pi threshold contract on a proportional reserve', () => {
    const budget = resolveCompactionBudget(19_000);
    expect(budget).toEqual({ reserveTokens: 2_850, provenance: 'proportional' });
    expect(shouldCompactConversation(16_150, 19_000, budget)).toBe(false);
    expect(shouldCompactConversation(16_151, 19_000, budget)).toBe(true);
  });

  it('caps retained context for small model windows without changing the large-window default', () => {
    const small = resolveCompactionBudget(16_000);
    expect(resolveCompactionKeepTokens(16_000, small)).toBe(6_800);
    const large = resolveCompactionBudget(128_000);
    expect(resolveCompactionKeepTokens(128_000, large)).toBe(20_000);
    expect(() => resolveCompactionKeepTokens(16_000, small, 0)).toThrow('positive integer');
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

  it('keeps a complete recent ToolCall batch for mid-turn compaction', () => {
    expect(
      planRuntimeCompaction({
        keepRecentTokens: 100,
        messages: [
          { index: 0, role: 'user', tokenCount: 80 },
          { index: 1, role: 'assistant', tokenCount: 120 },
          { index: 2, role: 'application', tokenCount: 40 },
          { index: 3, role: 'assistant', tokenCount: 70, toolCallIds: ['call-1'] },
          { index: 4, role: 'tool', tokenCount: 50, toolCallId: 'call-1' },
        ],
      }),
    ).toEqual({
      sourceFromIndex: 0,
      sourceThroughIndex: 2,
      firstKeptMessageIndex: 3,
      tokensBefore: 360,
      keptTokens: 120,
    });
  });

  it('fails closed on unresolved, duplicate, and orphaned tool protocol', () => {
    expect(() =>
      planRuntimeCompaction({
        keepRecentTokens: 1,
        messages: [
          { index: 0, role: 'user', tokenCount: 10 },
          { index: 1, role: 'assistant', tokenCount: 10, toolCallIds: ['call-1'] },
          { index: 2, role: 'assistant', tokenCount: 10 },
        ],
      }),
    ).toThrow('unresolved ToolCall');
    expect(() =>
      planRuntimeCompaction({
        keepRecentTokens: 1,
        messages: [
          { index: 0, role: 'user', tokenCount: 10 },
          { index: 1, role: 'assistant', tokenCount: 10, toolCallIds: ['call-1', 'call-1'] },
          { index: 2, role: 'tool', tokenCount: 10, toolCallId: 'call-1' },
        ],
      }),
    ).toThrow('unique non-empty ids');
    expect(() =>
      planRuntimeCompaction({
        keepRecentTokens: 1,
        messages: [
          { index: 0, role: 'user', tokenCount: 10 },
          { index: 1, role: 'tool', tokenCount: 10, toolCallId: 'call-1' },
          { index: 2, role: 'assistant', tokenCount: 10 },
        ],
      }),
    ).toThrow('match a preceding ToolCall');
  });

  it('does not cut immediately before an unpaired ToolResult', () => {
    expect(
      planRuntimeCompaction({
        keepRecentTokens: 10,
        messages: [
          { index: 0, role: 'user', tokenCount: 50 },
          { index: 1, role: 'assistant', tokenCount: 50, toolCallIds: ['call-1'] },
          { index: 2, role: 'tool', tokenCount: 50, toolCallId: 'call-1' },
        ],
      }),
    ).toEqual({
      sourceFromIndex: 0,
      sourceThroughIndex: 0,
      firstKeptMessageIndex: 1,
      tokensBefore: 150,
      keptTokens: 100,
    });
  });
});

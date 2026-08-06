import { describe, expect, it } from 'vitest';

import {
  articleOutcomeArtifactPresentation,
  articleOutcomeReceipt,
  articleOutcomeReceiptFromArtifact,
  withArticleOutcomeReceipt,
} from '../src/outcome-receipt.js';

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 2,
  costUsd: 0,
};

describe('article outcome receipt', () => {
  it('links direct and planned host receipts to an explicit article proposal', () => {
    expect(articleOutcomeReceipt('proposal-direct')).toEqual({
      kind: 'outcome_receipt',
      targetType: 'article-change',
      targetId: 'proposal-direct',
    });
    expect(
      articleOutcomeReceiptFromArtifact({
        type: 'EditProposal',
        content: { proposalId: 'proposal-planned' },
      }),
    ).toEqual({
      kind: 'outcome_receipt',
      targetType: 'article-change',
      targetId: 'proposal-planned',
    });
  });

  it('does not invent a target for an unrelated or incomplete artifact', () => {
    expect(
      articleOutcomeReceiptFromArtifact({ type: 'ResearchBrief', content: { proposalId: 'p' } }),
    ).toBeUndefined();
    expect(
      articleOutcomeReceiptFromArtifact({ type: 'EditProposal', content: {} }),
    ).toBeUndefined();
  });

  it('projects only the proposal association for an article outcome artifact', () => {
    expect(
      articleOutcomeArtifactPresentation({
        type: 'EditProposal',
        content: { proposalId: 'proposal-1', expectedHash: 'internal-hash' },
      }),
    ).toEqual({
      kind: 'outcome_artifact',
      targetType: 'article-change',
      targetId: 'proposal-1',
    });
  });

  it('marks the final planned completion when exactly one article proposal was produced', () => {
    const result = withArticleOutcomeReceipt(
      {
        status: 'completed',
        messages: [
          {
            role: 'assistant',
            content: '任务已完成。',
            provider: 'test',
            model: 'test',
            stopReason: 'stop',
            usage,
            timestamp: 1,
          },
        ],
      },
      [{ type: 'EditProposal', content: { proposalId: 'proposal-1' } }],
    );

    expect(result.messages[0]).toMatchObject({
      presentation: {
        kind: 'outcome_receipt',
        targetType: 'article-change',
        targetId: 'proposal-1',
      },
    });
  });

  it('keeps ordinary and ambiguous planned completions unmarked', () => {
    const result = {
      status: 'completed' as const,
      messages: [
        {
          role: 'assistant' as const,
          content: '任务已完成。',
          provider: 'test',
          model: 'test',
          stopReason: 'stop' as const,
          usage,
          timestamp: 1,
        },
      ],
    };
    expect(
      withArticleOutcomeReceipt(result, [
        { type: 'ResearchBrief', content: { proposalId: 'proposal-1' } },
      ]),
    ).toBe(result);
    expect(
      withArticleOutcomeReceipt(result, [
        { type: 'EditProposal', content: { proposalId: 'proposal-1' } },
        { type: 'EditProposal', content: { proposalId: 'proposal-2' } },
      ]),
    ).toBe(result);
  });
});

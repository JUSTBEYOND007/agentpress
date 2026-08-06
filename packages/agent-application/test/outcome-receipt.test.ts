import { describe, expect, it } from 'vitest';

import {
  articleOutcomeReceipt,
  articleOutcomeReceiptFromArtifact,
} from '../src/outcome-receipt.js';

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
});

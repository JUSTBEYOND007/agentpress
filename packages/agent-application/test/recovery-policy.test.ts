import { describe, expect, it, vi } from 'vitest';

import {
  recoverSettlement,
  SettlementOutcomeUnknownError,
  type RecoveryValidation,
} from '../src/recovery-policy.js';

const invalid: RecoveryValidation = {
  valid: false,
  issues: [{ code: 'state_conflict', message: 'State does not match the article body' }],
};
const preserved = [{ description: 'Article revision 3', revision: 'revision-3' }];

describe('settlement recovery policy', () => {
  it('retries settlement only and revalidates the retry', async () => {
    const settle = vi.fn((input: { validationFeedback: string }) => {
      expect(input.validationFeedback).toContain('state_conflict');
      return Promise.resolve({ state: 'fixed' });
    });
    const validate = vi.fn(() => Promise.resolve({ valid: true, issues: [] }));

    await expect(
      recoverSettlement({
        candidate: { body: 'article' },
        initialValidation: invalid,
        replaySafe: true,
        preservedFacts: preserved,
        missingFacts: ['chapter summary'],
        settle,
        validate,
      }),
    ).resolves.toMatchObject({ status: 'recovered', settlementAttempts: 1 });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('freezes facts and returns typed degradation when retry remains invalid', async () => {
    const result = await recoverSettlement({
      candidate: { body: 'article' },
      initialValidation: invalid,
      replaySafe: true,
      preservedFacts: preserved,
      missingFacts: ['chapter summary'],
      settle: vi.fn(() => Promise.resolve({ state: 'still-broken' })),
      validate: vi.fn(() =>
        Promise.resolve({
          valid: false,
          issues: [{ code: 'state_conflict', message: 'Still inconsistent' }],
        }),
      ),
    });
    expect(result).toMatchObject({
      status: 'completed_with_degradation',
      preservedFacts: preserved,
      missingFacts: ['chapter summary'],
      unverified: ['Still inconsistent'],
    });
  });

  it('does not retry a non-replay-safe settlement', async () => {
    const settle = vi.fn();
    const result = await recoverSettlement({
      candidate: 'candidate',
      initialValidation: invalid,
      replaySafe: false,
      preservedFacts: preserved,
      missingFacts: [],
      settle,
      validate: vi.fn(),
    });
    expect(result.status).toBe('completed_with_degradation');
    expect(result.settlementAttempts).toBe(0);
    expect(settle).not.toHaveBeenCalled();
  });

  it('keeps an unknown settlement outcome distinct from failure and degradation', async () => {
    const result = await recoverSettlement({
      candidate: 'candidate',
      initialValidation: invalid,
      replaySafe: true,
      preservedFacts: preserved,
      missingFacts: [],
      settle: vi.fn(() =>
        Promise.reject(new SettlementOutcomeUnknownError('commit connection lost')),
      ),
      validate: vi.fn(),
    });
    expect(result).toMatchObject({
      status: 'outcome_unknown',
      settlementAttempts: 1,
      reason: 'commit connection lost',
      preservedFacts: preserved,
    });
  });

  it('rejects a second settlement retry or an already-valid input', async () => {
    await expect(
      recoverSettlement({
        candidate: 'candidate',
        initialValidation: invalid,
        replaySafe: true,
        maxSettlementRetries: 2,
        preservedFacts: [],
        missingFacts: [],
        settle: vi.fn(),
        validate: vi.fn(),
      }),
    ).rejects.toThrow('0 or 1');
    await expect(
      recoverSettlement({
        candidate: 'candidate',
        initialValidation: { valid: true, issues: [] },
        replaySafe: true,
        preservedFacts: [],
        missingFacts: [],
        settle: vi.fn(),
        validate: vi.fn(),
      }),
    ).rejects.toThrow('initial validation failure');
  });
});

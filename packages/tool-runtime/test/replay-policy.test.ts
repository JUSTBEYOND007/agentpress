import { describe, expect, it } from 'vitest';

import { decideToolReplay, resolveToolReplaySafety } from '../src/index.js';

describe('tool replay policy', () => {
  it('derives conservative safety from the registered tool contract', () => {
    expect(resolveToolReplaySafety({ risk: 'read_only', idempotency: 'none' })).toBe('replay_safe');
    expect(resolveToolReplaySafety({ risk: 'external_write', idempotency: 'provider_key' })).toBe(
      'idempotent',
    );
    expect(resolveToolReplaySafety({ risk: 'draft_write', idempotency: 'none' })).toBe(
      'side_effecting',
    );
    expect(
      resolveToolReplaySafety({
        risk: 'read_only',
        idempotency: 'none',
        replaySafety: 'outcome_unknown',
      }),
    ).toBe('outcome_unknown');
  });

  it('does not replay settled calls', () => {
    expect(decideToolReplay({ status: 'succeeded', safety: 'side_effecting' })).toBe('skip');
    expect(decideToolReplay({ status: 'failed', safety: 'replay_safe' })).toBe('skip');
  });

  it('resumes replay-safe and keyed idempotent calls', () => {
    expect(decideToolReplay({ status: 'outcome_unknown', safety: 'replay_safe' })).toBe('resume');
    expect(
      decideToolReplay({ status: 'outcome_unknown', safety: 'idempotent', idempotencyKey: 'k-1' }),
    ).toBe('resume');
  });

  it('fails closed for unknown side effects without an idempotency proof', () => {
    expect(decideToolReplay({ status: 'outcome_unknown', safety: 'side_effecting' })).toBe(
      'fail_closed',
    );
    expect(decideToolReplay({ status: 'executing', safety: 'idempotent' })).toBe('fail_closed');
  });
});

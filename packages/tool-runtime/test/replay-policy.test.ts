import { describe, expect, it } from 'vitest';

import { decideToolReplay } from '../src/index.js';

describe('tool replay policy', () => {
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

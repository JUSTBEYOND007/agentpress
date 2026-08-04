import { describe, expect, it } from 'vitest';

import { runVisualState } from './agent-run-state';

describe('runVisualState', () => {
  it.each([
    ['tool.proposed', 'queued'],
    ['tool.executing', 'active'],
    ['run.waiting_for_user', 'waiting'],
    ['tool.succeeded', 'succeeded'],
    ['run.failed', 'failed'],
    ['run.cancelled', 'cancelled'],
    ['run.completed_with_degradation', 'degraded'],
    ['article.stale', 'stale'],
  ] as const)('maps %s to %s', (status, state) => {
    expect(runVisualState(status)).toBe(state);
  });
});

import { describe, expect, it } from 'vitest';

import { currentTurnSourceForRunStatus } from '../src/run-current-turn.js';

describe('currentTurnSourceForRunStatus', () => {
  it('keeps a new queued request user-authored', () => {
    expect(currentTurnSourceForRunStatus('queued')).toBe('user');
  });

  it('marks a resumed persisted run as host recovery', () => {
    expect(currentTurnSourceForRunStatus('recovering')).toBe('recovery');
  });
});

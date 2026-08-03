import { describe, expect, it } from 'vitest';

import { formatStepDuration } from './agent-execution-timeline';

describe('formatStepDuration', () => {
  it('formats persisted lifecycle durations', () => {
    expect(formatStepDuration(20)).toBe('<1 秒');
    expect(formatStepDuration(1_600)).toBe('2 秒');
  });
});

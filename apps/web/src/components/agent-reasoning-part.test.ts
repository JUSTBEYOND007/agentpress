import { describe, expect, it } from 'vitest';

import { formatDuration } from './agent-reasoning-part';

describe('formatDuration', () => {
  it('formats short and long reasoning durations without exposing model content', () => {
    expect(formatDuration(200)).toBe('<1 秒');
    expect(formatDuration(8_400)).toBe('8 秒');
    expect(formatDuration(65_000)).toBe('1 分 5 秒');
  });
});

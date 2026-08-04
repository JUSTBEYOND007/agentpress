import { describe, expect, it } from 'vitest';
import { classifyTerminalOutcome } from '../src/terminal-outcome-policy.js';

describe('terminal outcome policy', () => {
  it('maps every runtime result to one terminal outcome', () => {
    expect(classifyTerminalOutcome({ status: 'completed', messages: [] })).toBe('completed');
    expect(classifyTerminalOutcome({ status: 'cancelled', messages: [] })).toBe('cancelled');
    expect(
      classifyTerminalOutcome({
        status: 'failed',
        messages: [],
        error: { code: 'runtime_error', message: 'failed', retryable: false },
      }),
    ).toBe('failed');
  });
});

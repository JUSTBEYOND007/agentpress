import { describe, expect, it } from 'vitest';

import { runDirectivePath } from './agentpress-assistant-runtime';

describe('AgentPress assistant runtime commands', () => {
  it('routes steering and follow-up to opposite durable command streams', () => {
    expect(runDirectivePath('run-1', 'steering')).toBe('runs/run-1/steering');
    expect(runDirectivePath('run-1', 'follow-up')).toBe('runs/run-1/follow-ups');
  });
});

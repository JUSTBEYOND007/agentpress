import { describe, expect, it } from 'vitest';

import { executionTimelineView, formatStepDuration } from './agent-execution-timeline';
import type { RunPart } from '../lib/agentpress-assistant-runtime';

describe('formatStepDuration', () => {
  it('formats persisted lifecycle durations', () => {
    expect(formatStepDuration(20)).toBe('<1 秒');
    expect(formatStepDuration(1_600)).toBe('2 秒');
  });
});

describe('executionTimelineView', () => {
  it('summarizes interleaved settled and waiting steps from projected states', () => {
    expect(
      executionTimelineView([
        step('tool.succeeded', 'one'),
        step('tool.approval_requested', 'two'),
        step('tool.failed', 'three'),
      ]),
    ).toEqual({ state: 'failed', open: true, summary: '1/3 已完成' });
  });
});

function step(status: string, id: string): RunPart {
  return { id, runId: 'run', sequence: 1, type: 'activity', status, payload: {} };
}

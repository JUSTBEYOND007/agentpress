import { describe, expect, it } from 'vitest';

import { clearLiveRunContent, updateLiveRunContent } from './agent-streaming';

describe('Agent SSE live content', () => {
  it('appends direct Main Agent deltas in order', () => {
    const first = updateLiveRunContent([], {
      runId: 'run-1',
      mode: 'direct',
      eventType: 'content.delta',
      delta: '正在',
    });
    expect(
      updateLiveRunContent(first, {
        runId: 'run-1',
        mode: 'direct',
        eventType: 'content.delta',
        delta: '回答',
      }),
    ).toEqual([{ runId: 'run-1', text: '正在回答' }]);
  });

  it('does not expose planned Specialist deltas as the final answer', () => {
    expect(
      updateLiveRunContent([], {
        runId: 'run-1',
        mode: 'planned',
        eventType: 'content.delta',
        delta: 'internal task output',
      }),
    ).toEqual([]);
  });

  it('clears transient text at a new turn and after settlement', () => {
    const current = [{ runId: 'run-1', text: 'partial' }];
    expect(
      updateLiveRunContent(current, {
        runId: 'run-1',
        mode: 'direct',
        eventType: 'turn.started',
      }),
    ).toEqual([]);
    expect(clearLiveRunContent(current, 'run-1')).toEqual([]);
  });
});

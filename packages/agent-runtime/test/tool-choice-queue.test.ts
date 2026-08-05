// Behavior tests adapted from Oh My Pi v17.1.8, commit f446b8a (MIT).
// Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Boluk.
import { describe, expect, it } from 'vitest';

import { ToolChoiceQueue } from '../src/index.js';

describe('ToolChoiceQueue', () => {
  it('suppresses forced choices for steering but keeps them for follow-up turns', () => {
    const queue = new ToolChoiceQueue();
    queue.pushOnce({ type: 'tool', name: 'plan_submit' }, 'plan');
    expect(queue.next({ steeringPending: true, followUpPending: false })).toBeUndefined();
    expect(queue.next({ steeringPending: false, followUpPending: true })).toEqual({
      type: 'tool',
      name: 'plan_submit',
    });
    queue.resolve();
    expect(queue.inspect()).toEqual([]);
  });

  it('advances a sequence only after resolve and requeues rejected choices deterministically', () => {
    const queue = new ToolChoiceQueue();
    let rejects = 0;
    queue.pushSequence(['required', 'none'], 'plan-mode', ({ reason }) => {
      rejects += 1;
      return reason === 'aborted' ? 'requeue' : 'drop_sequence';
    });
    expect(queue.next({ steeringPending: false, followUpPending: false })).toBe('required');
    queue.reject('aborted');
    expect(queue.next({ steeringPending: false, followUpPending: false })).toBe('required');
    queue.resolve();
    expect(queue.next({ steeringPending: false, followUpPending: false })).toBe('none');
    queue.reject('unavailable');
    expect(rejects).toBe(2);
    expect(queue.next({ steeringPending: false, followUpPending: false })).toBeUndefined();
  });

  it('does not overwrite a pending directive when a second directive is added', () => {
    const queue = new ToolChoiceQueue();
    queue.pushOnce({ type: 'tool', name: 'first' }, 'first');
    queue.pushOnce({ type: 'tool', name: 'second' }, 'second');
    expect(queue.next({ steeringPending: false, followUpPending: false })).toEqual({
      type: 'tool',
      name: 'first',
    });
    queue.resolve();
    expect(queue.next({ steeringPending: false, followUpPending: false })).toEqual({
      type: 'tool',
      name: 'second',
    });
  });
});

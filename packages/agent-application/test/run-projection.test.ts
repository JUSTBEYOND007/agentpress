import { describe, expect, it } from 'vitest';

import type { DurableRunEvent } from '../src/contracts.js';
import { projectRunParts } from '../src/run-projection.js';
import { isTerminalRunStatus } from '../src/direct-run-service.js';

describe('run projection', () => {
  it('uses one server-side terminal classification', () => {
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('completed_with_degradation')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('cancelled')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
  });
  it('folds tool and task lifecycle events into their latest durable state', () => {
    const parts = projectRunParts([
      event(1, 'task.started', { taskId: 'task-1' }),
      event(2, 'tool.executing', { toolCallId: 'tool-1' }),
      event(3, 'tool.succeeded', { toolCallId: 'tool-1' }),
      event(4, 'task.succeeded', { taskId: 'task-1' }),
    ]);

    expect(parts).toHaveLength(2);
    expect(parts.map(({ status }) => status)).toEqual(['task.succeeded', 'tool.succeeded']);
    expect(parts.every(({ status }) => !status.includes('executing'))).toBe(true);
  });

  it('projects a bounded reasoning summary from durable planning lifecycle events', () => {
    const parts = projectRunParts([
      event(1, 'run.planning', { recovered: false }),
      event(2_501, 'tool.proposed', { toolCallId: 'tool-1' }),
    ]);

    expect(parts[0]).toMatchObject({
      type: 'reasoning',
      status: 'reasoning.completed',
      payload: { durationMs: 2_500 },
    });
    expect(JSON.stringify(parts[0]?.payload)).not.toContain('thinking');
  });

  it('keeps reasoning active until a visible execution boundary exists', () => {
    expect(projectRunParts([event(1, 'run.planning', {})])[0]).toMatchObject({
      type: 'reasoning',
      status: 'run.planning',
    });
  });

  it('annotates proposal output with its current persisted status', () => {
    const parts = projectRunParts(
      [
        event(1, 'tool.succeeded', {
          toolCallId: 'tool-1',
          output: { proposalId: 'proposal-1', operations: [], diffs: [] },
        }),
      ],
      new Map([['proposal-1', 'accepted']]),
    );

    expect(parts[0]?.payload).toMatchObject({ proposalStatus: 'accepted' });
  });

  it('projects action confirmation and article proposals as explicit parts', () => {
    const parts = projectRunParts([
      event(1, 'action.proposed', { id: 'action-1', instruction: '继续写' }),
      event(2, 'article.proposal.created', {
        proposalId: 'proposal-1',
        operations: [],
        diffs: [],
      }),
    ]);

    expect(parts.map(({ type }) => type)).toEqual(['action-proposal', 'article-change']);
  });

  it('folds an action decision into the original proposal card', () => {
    const parts = projectRunParts([
      event(1, 'action.proposed', { id: 'action-1', instruction: '继续写' }),
      event(2, 'action.confirmed', { proposalId: 'action-1', confirmedRunId: 'run-2' }),
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'action-proposal',
      status: 'action.confirmed',
      payload: { id: 'action-1', confirmedRunId: 'run-2' },
    });
  });
});

function event(
  sequence: number,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): DurableRunEvent {
  return {
    id: `event-${String(sequence)}`,
    runId: 'run-1',
    sequence,
    eventType,
    eventVersion: 1,
    payload,
    createdAt: new Date(sequence),
  };
}

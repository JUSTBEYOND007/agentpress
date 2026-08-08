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
      event(1, 'task.started', { taskId: 'task-1', attempt: 1 }),
      event(2, 'tool.executing', {
        toolCallId: 'tool-1',
        progress: { completed: 1, total: 2 },
      }),
      event(3, 'tool.succeeded', { toolCallId: 'tool-1' }),
      event(4, 'task.succeeded', { taskId: 'task-1', attempt: 1 }),
    ]);

    expect(parts).toHaveLength(2);
    expect(parts.map(({ status }) => status)).toEqual(['task.succeeded', 'tool.succeeded']);
    expect(parts.map(({ outcome }) => outcome)).toEqual(['succeeded', 'succeeded']);
    expect(parts.every(({ status }) => !status.includes('executing'))).toBe(true);
    expect(parts[0]?.payload).toMatchObject({ durationMs: 3 });
    expect(parts[1]?.payload).toMatchObject({ durationMs: 1 });
    expect(parts[1]?.payload.lifecycleStages).toEqual([
      {
        stageId: 'run-1:tool:tool-1:2',
        labelKey: 'execution.executing',
        status: 'tool.executing',
        startedAt: new Date(2).toISOString(),
        progress: { completed: 1, total: 2 },
        eventAt: new Date(2).toISOString(),
      },
      {
        stageId: 'run-1:tool:tool-1:3',
        labelKey: 'execution.succeeded',
        status: 'tool.succeeded',
        outcome: 'succeeded',
        completedAt: new Date(3).toISOString(),
        eventAt: new Date(3).toISOString(),
      },
    ]);
  });

  it('retains immutable MCP provenance across the folded ToolCall lifecycle', () => {
    const transportProvenance = {
      kind: 'mcp',
      serverId: 'web_research',
      serverRevision: '1.0.0',
      toolName: 'search',
      toolRevision: '1.0.0',
      adapterRevision: 'agentpress-mcp-adapter-v1',
    };
    const [part] = projectRunParts([
      event(1, 'tool.proposed', {
        toolCallId: 'tool-mcp',
        toolId: 'web.search',
        arguments: { query: 'bounded research' },
        transportProvenance,
      }),
      event(2, 'tool.executing', { toolCallId: 'tool-mcp' }),
      event(3, 'tool.succeeded', {
        toolCallId: 'tool-mcp',
        output: { source: 'mcp', value: [] },
      }),
    ]);

    expect(part).toMatchObject({
      type: 'activity',
      status: 'tool.succeeded',
      payload: {
        toolId: 'web.search',
        arguments: { query: 'bounded research' },
        transportProvenance,
      },
    });
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

  it('keeps interleaved tools and retries isolated by durable tool call identity', () => {
    const events = [
      event(1, 'tool.executing', { toolCallId: 'tool-a', summary: 'A attempt 1' }),
      event(2, 'tool.executing', { toolCallId: 'tool-b', summary: 'B' }),
      event(3, 'tool.failed', { toolCallId: 'tool-a', error: { code: 'timeout' } }),
      event(4, 'tool.succeeded', { toolCallId: 'tool-b' }),
      event(5, 'tool.executing', { toolCallId: 'tool-a-retry', summary: 'A attempt 2' }),
      event(6, 'tool.succeeded', { toolCallId: 'tool-a-retry' }),
    ];

    expect(projectRunParts(events).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'run-1:tool:tool-a', status: 'tool.failed' },
      { id: 'run-1:tool:tool-b', status: 'tool.succeeded' },
      { id: 'run-1:tool:tool-a-retry', status: 'tool.succeeded' },
    ]);
    expect(projectRunParts(events)).toEqual(projectRunParts(events));
  });

  it('projects host-owned typed outcomes without relying on consumer labels', () => {
    const parts = projectRunParts([
      event(1, 'task.timed_out', { taskId: 'task-timeout' }),
      event(2, 'task.cancelled', { taskId: 'task-cancelled' }),
      event(3, 'task.interrupted', { taskId: 'task-interrupted' }),
      event(4, 'task.stale', { taskId: 'task-stale' }),
      event(5, 'task.degraded', { taskId: 'task-degraded' }),
      event(6, 'task.failed', { taskId: 'task-failed' }),
    ]);
    expect(parts.map(({ outcome }) => outcome)).toEqual([
      'timed_out',
      'cancelled',
      'interrupted',
      'stale',
      'degraded',
      'failed',
    ]);
  });

  it('projects Specialist timeout from the persisted failure fact', () => {
    const [part] = projectRunParts([
      event(1, 'task.started', { taskId: 'task-timeout', attempt: 1 }),
      event(2, 'task.failed', { taskId: 'task-timeout', attempt: 1, failure: 'task_timeout' }),
    ]);
    expect(part).toMatchObject({
      status: 'task.failed',
      outcome: 'timed_out',
      payload: {
        lifecycleStages: [
          { status: 'task.started' },
          { status: 'task.failed', outcome: 'timed_out', labelKey: 'execution.timed_out' },
        ],
      },
    });
  });

  it('keeps an unknown ToolCall outcome distinct from an ordinary failure', () => {
    const parts = projectRunParts([
      event(1, 'tool.failed', { toolCallId: 'tool-failed', failure: { code: 'provider_failed' } }),
      event(2, 'tool.outcome_unknown', {
        toolCallId: 'tool-unknown',
        reason: 'connection_lost',
      }),
    ]);
    expect(parts.map(({ status, outcome }) => ({ status, outcome }))).toEqual([
      { status: 'tool.failed', outcome: 'failed' },
      { status: 'tool.outcome_unknown', outcome: 'outcome_unknown' },
    ]);
    expect(parts[1]?.type).toBe('warning');
    expect(parts[1]?.payload.lifecycleStages).toMatchObject([
      { labelKey: 'execution.outcome_unknown', outcome: 'outcome_unknown' },
    ]);
  });

  it('keeps task attempts isolated when an old attempt settles late', () => {
    const parts = projectRunParts([
      event(1, 'task.started', { taskId: 'task-retry', attempt: 1 }),
      event(2, 'task.started', { taskId: 'task-retry', attempt: 2 }),
      event(3, 'task.succeeded', { taskId: 'task-retry', attempt: 2 }),
      event(4, 'task.failed', { taskId: 'task-retry', attempt: 1 }),
    ]);
    expect(parts.map(({ correlationId, status }) => ({ correlationId, status }))).toEqual([
      { correlationId: 'task:task-retry:attempt:1', status: 'task.failed' },
      { correlationId: 'task:task-retry:attempt:2', status: 'task.succeeded' },
    ]);
  });

  it('does not guess task correlation when a legacy event has no attempt', () => {
    const parts = projectRunParts([
      event(1, 'task.started', { taskId: 'legacy-task' }),
      event(2, 'task.succeeded', { taskId: 'legacy-task' }),
    ]);
    expect(parts.map(({ id, correlationId }) => ({ id, correlationId }))).toEqual([
      { id: 'event-1', correlationId: undefined },
      { id: 'event-2', correlationId: undefined },
    ]);
  });

  it('projects approval while waiting and folds it into execution after continuation', () => {
    expect(
      projectRunParts([
        event(1, 'tool.proposed', { toolCallId: 'tool-1' }),
        event(2, 'tool.approval_requested', { toolCallId: 'tool-1' }),
      ])[0],
    ).toMatchObject({ type: 'tool-approval', status: 'tool.approval_requested' });

    expect(
      projectRunParts([
        event(1, 'tool.proposed', { toolCallId: 'tool-1' }),
        event(2, 'tool.approval_requested', { toolCallId: 'tool-1' }),
        event(3, 'tool.executing', { toolCallId: 'tool-1' }),
        event(4, 'tool.succeeded', { toolCallId: 'tool-1' }),
        event(5, 'run.completed', {}),
      ]).map(({ type, status }) => ({ type, status })),
    ).toEqual([
      { type: 'activity', status: 'tool.succeeded' },
      { type: 'usage', status: 'run.completed' },
    ]);
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

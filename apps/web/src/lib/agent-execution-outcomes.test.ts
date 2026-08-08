import { describe, expect, it } from 'vitest';

import type { RunPart } from './agent-runtime-contracts';
import { executionItems } from './agent-execution-projection';

describe('typed execution outcomes', () => {
  it('preserves timeout, cancellation, interruption, stale and degraded stages', () => {
    const activity = {
      ...part('task.succeeded', {
        taskId: 'task-typed-outcomes',
        lifecycleStages: [
          { status: 'opaque-1', outcome: 'timed_out', labelKey: 'execution.timed_out' },
          { status: 'opaque-2', outcome: 'cancelled', labelKey: 'execution.cancelled' },
          { status: 'opaque-3', outcome: 'interrupted', labelKey: 'execution.interrupted' },
          { status: 'opaque-4', outcome: 'stale', labelKey: 'execution.stale' },
          { status: 'opaque-5', outcome: 'degraded', labelKey: 'execution.degraded' },
        ],
      }),
      outcome: 'degraded' as const,
    };
    const [item] = executionItems([activity], [activity]);
    expect(item).toMatchObject({
      kind: 'pipeline',
      status: 'degraded',
      stages: [
        { status: 'timed_out', label: '已超时' },
        { status: 'cancelled', label: '已取消' },
        { status: 'interrupted', label: '已中断' },
        { status: 'stale', label: '已过期' },
        { status: 'degraded', label: '部分完成' },
      ],
    });
  });

  it('keeps outcome unknown as a warning state', () => {
    const activity = part('tool.outcome_unknown', {
      toolId: 'web.search',
      toolCallId: 'unknown-1',
      failure: {
        code: 'outcome_unknown',
        messageKey: 'tool.failure.outcome_unknown',
        retryable: false,
      },
    });
    const [item] = executionItems([activity], [activity]);
    expect(item).toMatchObject({
      kind: 'utility-group',
      status: 'outcome_unknown',
      items: [{ status: 'outcome_unknown' }],
    });
  });

  it('isolates MCP transport diagnostics from the consumer business item', () => {
    const activity = part('tool.outcome_unknown', {
      toolId: 'web.search',
      toolCallId: 'unknown-mcp',
      arguments: { query: 'private query value' },
      transportProvenance: {
        kind: 'mcp',
        serverId: 'web_research',
        serverRevision: '1.0.0',
        toolName: 'search',
        toolRevision: '1.0.0',
        adapterRevision: 'agentpress-mcp-adapter-v1',
      },
      failure: {
        code: 'outcome_unknown',
        messageKey: 'tool.failure.outcome_unknown',
        retryable: false,
        outcomeReason: 'stale_client_result',
        message: 'authorization=private-token',
        stack: '/private/provider-client.ts:42',
      },
    });

    const [item] = executionItems([activity], [activity]);
    expect(item).toMatchObject({
      kind: 'utility-group',
      status: 'outcome_unknown',
      items: [
        {
          label: '搜索资料',
          status: 'outcome_unknown',
          audit: {
            kind: 'mcp',
            serverId: 'web_research',
            serverRevision: '1.0.0',
            toolName: 'search',
            toolRevision: '1.0.0',
            adapterRevision: 'agentpress-mcp-adapter-v1',
            argumentNames: ['query'],
            argumentCount: 1,
          },
        },
      ],
    });
    expect(JSON.stringify(item)).not.toContain('private query value');
    expect(JSON.stringify(item)).not.toContain('stale_client_result');
    expect(JSON.stringify(item)).not.toContain('private-token');
    expect(JSON.stringify(item)).not.toContain('/private/provider-client.ts');
  });
});

function part(status: string, payload: Readonly<Record<string, unknown>>): RunPart {
  return {
    id: 'activity-1',
    runId: 'run-1',
    sequence: 1,
    type: 'activity',
    status,
    payload,
  };
}

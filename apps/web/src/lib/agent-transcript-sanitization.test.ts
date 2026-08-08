import { describe, expect, it } from 'vitest';

import type { RunPart, RunProjection } from './agent-runtime-contracts';
import { projectionContent } from './agent-runtime-projection';

describe('Agent transcript sanitization', () => {
  it('excludes protocol, headers, stack, thinking, and oversized output from every tool state', () => {
    const forbidden = {
      jsonRpc: { jsonrpc: '2.0', id: 99, method: 'tools/call' },
      headers: { authorization: 'Bearer credential-secret' },
      stack: '/private/provider-stack.ts:42',
      privateThinking: 'provider-private-reasoning',
      providerResponse: 'provider-raw-response',
    };
    const tool = {
      toolId: 'web.search',
      toolCallId: 'call-sensitive',
      transportProvenance: {
        kind: 'mcp',
        serverId: 'web_research',
        serverRevision: '1.0.0',
        toolName: 'search',
        toolRevision: '1.0.0',
        adapterRevision: 'agentpress-mcp-adapter-v1',
      },
    };
    const content = projectionContent(
      projection([
        part('activity', 'tool.succeeded', 1, {
          ...tool,
          ...forbidden,
          lifecycleStages: [
            {
              stageId: 'stage-1',
              labelKey: 'execution.succeeded',
              status: 'tool.succeeded',
              outcome: 'succeeded',
              eventAt: '2026-08-09T00:00:00.000Z',
              headers: forbidden.headers,
              privateThinking: forbidden.privateThinking,
            },
          ],
          output: { summary: 'Bounded result', raw: 'x'.repeat(50_000), ...forbidden },
        }),
        part('activity', 'tool.failed', 2, {
          ...tool,
          toolCallId: 'call-failed-sensitive',
          ...forbidden,
          failure: {
            code: 'provider_failed',
            messageKey: 'tool.failure.provider',
            retryable: true,
            ...forbidden,
          },
        }),
        part('tool-approval', 'tool.approval_requested', 3, {
          ...tool,
          toolCallId: 'call-approval-sensitive',
          sideEffect: '读取授权来源',
          arguments: { token: 'approval-token-secret' },
          ...forbidden,
        }),
        part('usage', 'run.completed', 4, { durationMs: 10 }),
      ]),
    );
    const serialized = JSON.stringify(content);

    expect(serialized).toContain('Bounded result');
    expect(serialized).toContain('tool.failure.provider');
    for (const secret of [
      'tools/call',
      'credential-secret',
      '/private/provider-stack.ts:42',
      'provider-private-reasoning',
      'provider-raw-response',
      'approval-token-secret',
      'x'.repeat(1_000),
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

function projection(parts: readonly RunPart[]): RunProjection {
  return {
    runId: 'run-1',
    rootMessageId: 'message-1',
    status: 'completed',
    terminal: true,
    mode: 'direct',
    parts,
    artifacts: [],
    agents: [],
    pendingDirectives: [],
    lastEventId: 4,
    createdAt: '2026-08-09T00:00:00.000Z',
  };
}

function part(
  type: RunPart['type'],
  status: string,
  sequence: number,
  payload: Readonly<Record<string, unknown>>,
): RunPart {
  return { id: `${type}-${String(sequence)}`, runId: 'run-1', sequence, type, status, payload };
}

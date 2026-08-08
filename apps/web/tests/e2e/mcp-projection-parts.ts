const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export function mcpProjectionParts(
  terminal: boolean,
): readonly Readonly<Record<string, unknown>>[] {
  if (!terminal) {
    return [
      activity('mcp-running', 5, 'tool.executing', {
        toolId: 'web.search',
        toolCallId: 'mcp-running-call',
      }),
    ];
  }
  const transportProvenance = {
    kind: 'mcp',
    serverId: 'web_research_server_with_a_deliberately_long_but_bounded_identifier',
    serverRevision: '2026.08.09-revision-with-backward-compatible-search-schema',
    toolName: 'search_sources_with_a_deliberately_long_but_bounded_name',
    toolRevision: '4.2.0-revision-with-source-deduplication',
    adapterRevision: 'agentpress-mcp-adapter-v1',
  };
  return [
    activity('mcp-success', 5, 'tool.succeeded', {
      toolId: 'web.search',
      toolCallId: 'mcp-success-call',
      taskAttempt: 3,
      durationMs: 1_250,
      transportRetryCount: 2,
      transportReconnectCount: 1,
      transportProvenance,
      arguments: { query: 'credential-secret-query' },
      headers: { authorization: 'Bearer browser-secret' },
      privateThinking: 'browser-private-thinking',
      evidenceReferences: [
        {
          evidenceId: 'evidence-browser-1',
          title: '主要资料来源',
          source: 'https://example.test/source',
          sourceRevision: 'sha256:browser-source',
        },
      ],
      output: { summary: '已找到并核对 1 个来源', raw: 'oversized-provider-output'.repeat(2_000) },
    }),
    activity('mcp-rate-limit', 6, 'tool.failed', {
      toolId: 'web.search',
      toolCallId: 'mcp-rate-limit-call',
      transportProvenance,
      failure: {
        code: 'tool_rate_limited',
        messageKey: 'tool.failure.rate_limited',
        retryable: true,
        message: 'provider credential=rate-limit-secret',
        stack: '/private/mcp-provider.ts:42',
      },
    }),
    activity('mcp-denied', 7, 'tool.denied', {
      toolId: 'media.import_licensed',
      toolCallId: 'mcp-denied-call',
      transportProvenance: { ...transportProvenance, serverId: 'licensed_media' },
    }),
    {
      id: `${runId}-mcp-unknown`,
      runId,
      sequence: 8,
      type: 'warning',
      status: 'tool.outcome_unknown',
      outcome: 'outcome_unknown',
      payload: {
        toolId: 'web.search',
        toolCallId: 'mcp-unknown-call',
        reason: 'connection_lost_after_dispatch',
        failure: {
          code: 'outcome_unknown',
          messageKey: 'tool.failure.outcome_unknown',
          retryable: false,
          outcomeReason: 'connection_lost_after_dispatch',
        },
        jsonRpc: { jsonrpc: '2.0', method: 'tools/call' },
      },
    },
    {
      id: `${runId}-mcp-run-warning`,
      runId,
      sequence: 9,
      type: 'warning',
      status: 'run.completed_with_degradation',
      payload: {},
    },
    {
      id: `${runId}-mcp-text`,
      runId,
      sequence: 10,
      type: 'text',
      status: 'text.completed',
      payload: { message: { content: '# MCP 失败矩阵已完成\n\n已保留可确认的资料结果。' } },
    },
  ];
}

function activity(
  id: string,
  sequence: number,
  status: string,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { id: `${runId}-${id}`, runId, sequence, type: 'activity', status, payload };
}

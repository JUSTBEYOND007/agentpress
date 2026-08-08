import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentRunProcess, parseProcessPresentation, processSummary } from './agent-run-process';

describe('Agent run process disclosure', () => {
  it('reduces diagnostic-only process data to one thinking line', () => {
    const data = {
      runId: 'run-1',
      status: 'completed',
      terminal: true,
      durationMs: 19_000,
      parts: [
        {
          id: 'reasoning-1',
          runId: 'run-1',
          sequence: 1,
          type: 'reasoning',
          status: 'reasoning.completed',
          payload: { durationMs: 7_000 },
        },
        {
          id: 'usage-1',
          runId: 'run-1',
          sequence: 2,
          type: 'usage',
          status: 'execution.facts',
          payload: {
            durationMs: 19_000,
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0 },
            executions: [{ provider: 'agent-model', model: 'gpt-test', purpose: 'main' }],
          },
        },
      ],
    };
    const markup = renderToStaticMarkup(<AgentRunProcess data={data} />);

    expect(markup).toContain('思考了 7 秒');
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('agent-model');
    expect(markup).not.toContain('token');
    const process = parseProcessPresentation(data);
    expect(process).toBeDefined();
    if (!process) return;
    expect(processSummary(process)).toMatchObject({
      label: '过程详情',
      meta: '',
    });
  });

  it('shows deduplicated business steps without runtime diagnostics', () => {
    const markup = renderToStaticMarkup(
      <AgentRunProcess
        data={{
          runId: 'run-1',
          status: 'completed',
          terminal: true,
          durationMs: 19_000,
          parts: [
            activity('read-proposed', 1, 'tool.proposed', 'article.read_current', 'call-1'),
            activity('read-done', 2, 'tool.succeeded', 'article.read_current', 'call-1'),
            activity('edit-done', 3, 'tool.succeeded', 'article.propose_edits', 'call-2'),
            activity('internal', 4, 'tool.succeeded', 'internal.runtime', 'call-3'),
            activity('search-failed', 5, 'tool.failed', 'web.search', 'call-4'),
          ],
        }}
      />,
    );

    expect(markup).toContain('过程详情');
    expect(markup.match(/读取正文/gu)).toHaveLength(1);
    expect(markup.match(/生成修改稿/gu)).toHaveLength(1);
    expect(markup).not.toContain('internal.runtime');
    expect(markup).not.toContain('搜索资料');
    expect(markup).toContain('19 秒');
    expect(markup).not.toContain('token');
    expect(markup).not.toContain('<details open');
  });

  it('keeps the active pipeline open while the run is streaming', () => {
    const markup = renderToStaticMarkup(
      <AgentRunProcess
        data={{
          runId: 'run-1',
          status: 'running',
          terminal: false,
          durationMs: 0,
          items: [
            {
              kind: 'pipeline',
              id: 'tool-1',
              label: '生成修改稿',
              status: 'processing',
              durationMs: 0,
              sequence: 1,
              stages: [],
            },
          ],
          parts: [activity('activity-1', 1, 'tool.executing', 'article.propose_edits', 'call-1')],
        }}
      />,
    );

    expect(markup.match(/生成修改稿/gu)).toHaveLength(2);
    expect(markup).toContain('<details class="run-process-details" open="">');
    expect(markup).toContain('进行中');
  });

  it('does not expose generic lifecycle labels as duplicate pipeline stages', () => {
    const markup = renderToStaticMarkup(
      <AgentRunProcess
        data={{
          runId: 'run-1',
          status: 'completed',
          terminal: true,
          durationMs: 0,
          items: [
            {
              kind: 'pipeline',
              id: 'tool-1',
              label: '生成修改稿',
              status: 'completed',
              durationMs: 1000,
              sequence: 1,
              stages: [],
              result: { summary: '已生成修改' },
            },
          ],
          parts: [],
        }}
      />,
    );
    expect(markup.match(/生成修改稿/gu)).toHaveLength(1);
    expect(markup).toContain('已生成修改');
    expect(markup).not.toContain('已开始');
    expect(markup).not.toContain('结果已生成');
  });

  it('keeps active reasoning in the same open process disclosure', () => {
    const markup = renderToStaticMarkup(
      <AgentRunProcess
        data={{
          runId: 'run-1',
          status: 'planning',
          terminal: false,
          durationMs: 0,
          parts: [
            {
              id: 'reasoning-1',
              runId: 'run-1',
              sequence: 1,
              type: 'reasoning',
              status: 'run.planning',
              payload: {},
            },
          ],
          items: [],
        }}
      />,
    );
    expect(markup).toContain('<details class="run-process-details" open="">');
    expect(markup).toContain('正在思考');
  });

  it('groups consecutive utility operations while keeping pipeline details available', () => {
    const markup = renderToStaticMarkup(
      <AgentRunProcess
        data={{
          runId: 'run-1',
          status: 'completed',
          terminal: true,
          durationMs: 0,
          items: [
            {
              kind: 'utility-group',
              id: 'utility-1',
              count: 2,
              status: 'completed',
              sequence: 1,
              items: [
                { id: 'tool:1', label: '读取正文', status: 'completed', sequence: 1 },
                { id: 'tool:2', label: '搜索资料', status: 'completed', sequence: 2 },
              ],
            },
            {
              kind: 'pipeline',
              id: 'tool:3',
              label: '生成修改稿',
              status: 'completed',
              durationMs: 1800,
              sequence: 3,
              stages: [{ id: 'stage-1', label: '生成修改提案', status: 'completed' }],
              result: { summary: '已生成修改' },
            },
          ],
          parts: [],
        }}
      />,
    );
    expect(markup).toContain('2 个文件操作');
    expect(markup).toContain('生成修改稿');
    expect(markup).toContain('已生成修改');
    expect(markup).toContain('2 秒');
  });

  it('discloses MCP provenance on demand without exposing argument values', () => {
    const markup = renderToStaticMarkup(
      <AgentRunProcess
        data={{
          runId: 'run-1',
          status: 'completed',
          terminal: true,
          durationMs: 420,
          items: [
            {
              kind: 'utility-group',
              id: 'utility-mcp',
              count: 1,
              status: 'completed',
              sequence: 1,
              items: [
                {
                  id: 'tool:mcp-1',
                  label: '搜索资料',
                  status: 'completed',
                  sequence: 1,
                  audit: {
                    kind: 'mcp',
                    serverId: 'web_research',
                    serverRevision: '1.0.0',
                    toolName: 'search',
                    toolRevision: '1.0.0',
                    adapterRevision: 'agentpress-mcp-adapter-v1',
                    taskAttempt: 2,
                    argumentNames: ['limit', 'query'],
                    argumentCount: 2,
                    transportRetryCount: 1,
                    transportReconnectCount: 1,
                    argumentSummary: {
                      schemaVersion: 1,
                      fieldCount: 2,
                      additionalFieldCount: 0,
                      fields: [
                        {
                          name: 'limit',
                          required: false,
                          schemaTypes: ['integer'],
                          valueType: 'integer',
                        },
                        {
                          name: 'query',
                          required: true,
                          schemaTypes: ['string'],
                          valueType: 'string',
                          stringLength: 16,
                        },
                      ],
                    },
                    outputReference: {
                      artifactId: 'artifact-1',
                      uri: 'artifact://artifact-1/versions/1',
                    },
                  },
                },
              ],
            },
          ],
          parts: [],
        }}
      />,
    );

    expect(markup).toContain('搜索资料');
    expect(markup).toContain('MCP 调用详情');
    expect(markup).toContain('web_research@1.0.0');
    expect(markup).toContain('search@1.0.0');
    expect(markup).toContain('agentpress-mcp-adapter-v1');
    expect(markup).toContain('limit (integer)');
    expect(markup).toContain('query (string, 长度 16)');
    expect(markup).toContain('1 次重试，1 次重连');
    expect(markup).toContain('artifact://artifact-1/versions/1');
    expect(markup).not.toContain('top-secret-query');
  });
});

function activity(
  id: string,
  sequence: number,
  status: string,
  toolId: string,
  toolCallId: string,
) {
  return {
    id,
    runId: 'run-1',
    sequence,
    type: 'activity' as const,
    status,
    payload: { toolId, toolCallId },
  };
}

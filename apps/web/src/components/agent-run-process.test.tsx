import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentRunProcess, parseProcessPresentation, processSummary } from './agent-run-process';

describe('Agent run process disclosure', () => {
  it('does not render a disclosure for diagnostic-only process data', () => {
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

    expect(markup).toBe('');
    const process = parseProcessPresentation(data);
    expect(process).toBeDefined();
    if (!process) return;
    expect(processSummary(process)).toMatchObject({
      label: '执行过程',
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

    expect(markup).toContain('执行过程');
    expect(markup.match(/读取正文/gu)).toHaveLength(1);
    expect(markup.match(/生成修改稿/gu)).toHaveLength(1);
    expect(markup).not.toContain('internal.runtime');
    expect(markup).not.toContain('搜索资料');
    expect(markup).not.toContain('19 秒');
    expect(markup).not.toContain('token');
    expect(markup).not.toContain('<details open');
  });

  it('shows only one current status line before details for an active run', () => {
    const markup = renderToStaticMarkup(
      <AgentRunProcess
        data={{
          runId: 'run-1',
          status: 'running',
          terminal: false,
          durationMs: 0,
          parts: [
            activity('activity-1', 1, 'tool.executing', 'article.propose_edits', 'call-1'),
          ],
        }}
      />,
    );

    expect(markup.match(/正在生成修改稿/gu)).toHaveLength(1);
    expect(markup).not.toContain('<details');
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

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentRunProcess, parseProcessPresentation, processSummary } from './agent-run-process';

describe('Agent run process disclosure', () => {
  it('keeps diagnostic facts in one collapsed disclosure', () => {
    const data = {
      runId: 'run-1',
      status: 'completed',
      terminal: true,
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

    expect(markup).toContain('过程详情');
    expect(markup).toContain('19 秒');
    expect(markup).toContain('agent-model / gpt-test');
    expect(markup).not.toContain('<details open');
    expect(markup).not.toContain('分析过程由运行时托管');
    const process = parseProcessPresentation(data);
    expect(process).toBeDefined();
    if (!process) return;
    expect(processSummary(process)).toMatchObject({
      state: 'succeeded',
      label: '过程详情',
      meta: '19 秒',
    });
  });

  it('shows only one current status line before details for an active run', () => {
    const markup = renderToStaticMarkup(
      <AgentRunProcess
        data={{
          runId: 'run-1',
          status: 'running',
          terminal: false,
          parts: [
            {
              id: 'activity-1',
              runId: 'run-1',
              sequence: 1,
              type: 'activity',
              status: 'tool.executing',
              payload: { summary: '正在修改正文' },
            },
          ],
        }}
      />,
    );

    expect(markup.match(/正在修改正文/gu)).toHaveLength(2);
    expect(markup).not.toContain('<details open');
  });
});

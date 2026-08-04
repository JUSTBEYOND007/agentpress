import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentUsagePart, executionFactsView } from './agent-usage-part';

describe('Agent usage part', () => {
  it('renders captured model limits, duration, token breakdown and zero cost', () => {
    const payload = {
      durationMs: 2500,
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        totalTokens: 150,
        costUsd: 0,
      },
      executions: [
        {
          purpose: 'direct',
          provider: 'agent-model',
          model: 'gpt-5.6-luna',
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
          fallbackUsed: false,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <AgentUsagePart
        part={{
          id: 'usage-1',
          runId: 'run-1',
          sequence: 3,
          type: 'usage',
          status: 'execution.facts',
          payload,
        }}
      />,
    );

    expect(markup).toContain('agent-model / gpt-5.6-luna');
    expect(markup).toContain('上下文 128,000');
    expect(markup).toContain('输出上限 16,384');
    expect(markup).toContain('150 tokens');
    expect(markup).toContain('US$0.00');
    expect(executionFactsView(payload)).toMatchObject({ durationMs: 2500, totalTokens: 150 });
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { formatDuration, ReasoningPart } from './agent-reasoning-part';

describe('formatDuration', () => {
  it('formats short and long reasoning durations without exposing model content', () => {
    expect(formatDuration(200)).toBe('<1 秒');
    expect(formatDuration(8_400)).toBe('8 秒');
    expect(formatDuration(65_000)).toBe('1 分 5 秒');
  });

  it('renders one non-collapsible planning status without an empty disclosure', () => {
    const markup = renderToStaticMarkup(
      createElement(ReasoningPart, {
        part: {
          id: 'reasoning-1',
          runId: 'run-1',
          sequence: 1,
          type: 'reasoning',
          status: 'run.planning',
          payload: {},
        },
      }),
    );
    expect(markup).toContain('正在思考');
    expect(markup).not.toContain('<details');
  });
});

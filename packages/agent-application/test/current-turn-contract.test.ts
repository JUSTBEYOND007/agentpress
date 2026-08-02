import { describe, expect, it } from 'vitest';

import {
  CURRENT_TURN_AUTHORITY_POLICY,
  mainPlanningPrompt,
  serializeCurrentTurn,
} from '../src/index.js';

describe('current turn contract', () => {
  it('keeps the current request separate from reference-only frozen context', () => {
    const prompt = serializeCurrentTurn({
      request: '你好',
      frozenContext: '<context kind="mention">请续写 Sony a6700 文章</context>',
    });

    expect(prompt).toContain('<current-request-json>"你好"</current-request-json>');
    expect(prompt).toContain('<frozen-context role="reference-only">');
    expect(prompt.indexOf('<current-request-json>')).toBeLessThan(
      prompt.indexOf('<frozen-context'),
    );
  });

  it('defines current intent as authoritative without disabling explicit continuation', () => {
    expect(CURRENT_TURN_AUTHORITY_POLICY).toContain('sole authoritative source');
    expect(CURRENT_TURN_AUTHORITY_POLICY).toContain('Never infer, resume, repeat, or extend');
    expect(CURRENT_TURN_AUTHORITY_POLICY).toContain('explicitly refers to it');
    expect(mainPlanningPrompt(['article.propose'])).toContain(CURRENT_TURN_AUTHORITY_POLICY);
  });
});

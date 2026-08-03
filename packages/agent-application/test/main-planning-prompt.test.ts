import { describe, expect, it } from 'vitest';

import { mainPlanningPrompt } from '../src/planned-run-executor.js';

describe('mainPlanningPrompt', () => {
  it('directs article sessions to the domain edit tool', () => {
    const prompt = mainPlanningPrompt(['article.read', 'article.propose']);

    expect(prompt).toContain('call article.propose_edits directly');
    expect(prompt).toContain('reviewMode="document"');
    expect(prompt).toContain('reviewMode="granular"');
    expect(prompt).toContain('do not call action_propose');
  });

  it('does not claim edit capability when the host did not grant it', () => {
    const prompt = mainPlanningPrompt(['article.read']);

    expect(prompt).toContain('no article.propose capability is available');
    expect(prompt).not.toContain('call article.propose_edits directly');
  });
});

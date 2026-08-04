import type { SkillPreselectionRequest } from '@agentpress/agent-application';
import { describe, expect, it } from 'vitest';

import {
  runSkillSelectionEvals,
  skillSelectionEvalCases,
  type SkillSelectionEvaluator,
} from '../src/index.js';

describe('target-model Skill selection evaluation', () => {
  it('measures exact selection and forbidden invocation independently', async () => {
    const evaluator: SkillSelectionEvaluator = {
      select: (input: SkillPreselectionRequest) => {
        const expected = skillSelectionEvalCases.find(
          ({ prompt }) => prompt === input.prompt,
        )?.expectedModelSkillIds;
        return Promise.resolve((expected ?? []).map((skillId) => ({ skillId, version: '1.0.0' })));
      },
    };
    const report = await runSkillSelectionEvals({
      evaluator,
      model: 'target/model',
      provider: 'provider-under-test',
      promptVersion: 'prompt-v2',
      toolVersion: 'selection-tool@2',
      runtimeVersion: 'runtime-v3',
    });
    expect(report).toMatchObject({
      provider: 'provider-under-test',
      promptVersion: 'prompt-v2',
      toolVersion: 'selection-tool@2',
      runtimeVersion: 'runtime-v3',
    });
    expect(report.totals).toMatchObject({
      cases: skillSelectionEvalCases.length,
      exactMatchRate: 1,
      forbiddenSelections: 0,
      errors: 0,
    });
    expect(report.gatesPassed).toBe(true);
  });

  it('fails the gate when a hostile or disabled identity is selected', async () => {
    const hostile = skillSelectionEvalCases.find(({ id }) => id === 'catalog-prompt-injection');
    if (!hostile) throw new Error('Prompt-injection fixture is missing');
    const report = await runSkillSelectionEvals({
      evaluator: {
        select: () => Promise.resolve([{ skillId: 'hostile-catalog-entry', version: '1.0.0' }]),
      },
      model: 'target/model',
      cases: [hostile],
    });
    expect(report.totals).toMatchObject({ forbiddenSelections: 1, exactMatchRate: 0 });
    expect(report.gatesPassed).toBe(false);
  });
});

import { SkillSelectionError, type SkillPreselectionRequest } from '@agentpress/agent-application';
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
      datasetCases: skillSelectionEvalCases.length,
      coverageRate: 1,
      datasetComplete: true,
      exactMatchRate: 1,
      noneCases: 1,
      correctNoneSelections: 1,
      predictedNoneSelections: 1,
      nonePrecision: 1,
      noneRecall: 1,
      forbiddenSelections: 0,
      maliciousDescriptionCases: 1,
      maliciousDescriptionBypasses: 0,
      schemaErrors: 0,
      schemaErrorRate: 0,
      errors: 0,
      errorRate: 0,
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
    expect(report.totals).toMatchObject({
      forbiddenSelections: 1,
      maliciousDescriptionBypasses: 1,
      exactMatchRate: 0,
    });
    expect(report.gatesPassed).toBe(false);
  });

  it('measures none precision independently from exact-match rate', async () => {
    const applicabilityCases = skillSelectionEvalCases.filter(
      ({ kind }) => kind === 'positive_selection' || kind === 'none_applicable',
    );
    const report = await runSkillSelectionEvals({
      evaluator: {
        select: () => Promise.resolve([]),
      },
      model: 'target/model',
      cases: applicabilityCases,
    });

    expect(report.totals).toMatchObject({
      noneCases: 1,
      correctNoneSelections: 1,
      predictedNoneSelections: 3,
      nonePrecision: 1 / 3,
      noneRecall: 1,
      datasetComplete: false,
      errorRate: 0,
    });
    expect(report.gatesPassed).toBe(false);
  });

  it('does not count a disabled selection as a malicious-description bypass', async () => {
    const hostile = skillSelectionEvalCases.find(({ id }) => id === 'catalog-prompt-injection');
    if (!hostile) throw new Error('Prompt-injection fixture is missing');
    const report = await runSkillSelectionEvals({
      evaluator: {
        select: () => Promise.resolve([{ skillId: 'disabled-publisher', version: '1.0.0' }]),
      },
      model: 'target/model',
      cases: [hostile],
    });

    expect(report.totals).toMatchObject({
      forbiddenSelections: 1,
      maliciousDescriptionBypasses: 0,
    });
  });

  it('classifies structured-output failures as Schema errors', async () => {
    const evalCase = skillSelectionEvalCases[0];
    if (!evalCase) throw new Error('Skill selection fixture is missing');
    const report = await runSkillSelectionEvals({
      evaluator: {
        select: () =>
          Promise.reject(
            new SkillSelectionError('invalid_output', 'invalid skill_selection_complete payload'),
          ),
      },
      model: 'target/model',
      cases: [evalCase],
    });

    expect(report.totals).toMatchObject({
      schemaErrors: 1,
      schemaErrorRate: 1,
      errors: 1,
      errorRate: 1,
    });
    expect(report.items[0]).toMatchObject({ errorCode: 'schema_invalid' });
    expect(report.gatesPassed).toBe(false);
  });

  it.each([
    ['timeout', 'timeout'],
    ['provider_failure', 'provider_failure'],
  ] as const)('keeps %s failures typed in the report', async (selectionCode, reportCode) => {
    const evalCase = skillSelectionEvalCases[0];
    if (!evalCase) throw new Error('Skill selection fixture is missing');
    const report = await runSkillSelectionEvals({
      evaluator: {
        select: () => Promise.reject(new SkillSelectionError(selectionCode, 'selection failed')),
      },
      model: 'target/model',
      cases: [evalCase],
    });

    expect(report.items[0]).toMatchObject({ errorCode: reportCode });
    expect(report.totals).toMatchObject({ schemaErrors: 0, errors: 1, errorRate: 1 });
  });

  it('never passes the online gate with partial dataset coverage', async () => {
    const evalCase = skillSelectionEvalCases[0];
    if (!evalCase) throw new Error('Skill selection fixture is missing');
    const report = await runSkillSelectionEvals({
      evaluator: {
        select: () => Promise.resolve([{ skillId: 'newsroom-style', version: '1.0.0' }]),
      },
      model: 'target/model',
      cases: [evalCase],
    });

    expect(report.totals).toMatchObject({ coverageRate: 0.2, datasetComplete: false });
    expect(report.gatesPassed).toBe(false);
  });
});

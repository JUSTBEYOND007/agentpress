import { describe, expect, it } from 'vitest';

import {
  COMPACTION_EVAL_DATASET_VERSION,
  COMPACTION_EVAL_REQUIREMENTS,
  compactionEvalCases,
  scoreCompactionSummary,
} from '../src/index.js';

const goldenSummaries: Readonly<Record<string, string>> = {
  'intent-and-unsettled-action':
    'Prepare a sourced launch brief. Do not publish. EVID-ALPHA-732 remains evidence and TOOL-PENDING-734 is awaiting approval.',
  'incremental-stale-state':
    'STATE-DRAFT-PENDING-810 and EVID-BETA-811 are historical. STATE-DRAFT-REJECTED-812 is current: the draft was rejected and do not call it approved.',
  'citation-and-unknown':
    'CLAIM-UNKNOWN-901 has no verified answer. EVID-GAMMA-902 verifies only the publication date.',
  'sibling-branch-isolation':
    'BRANCH-A-GOAL-920 tracks the public launch timeline with EVID-BRANCH-A-921.',
};

describe('compaction evaluation dataset', () => {
  it('is versioned, unique, and covers every required Summary behavior', () => {
    expect(COMPACTION_EVAL_DATASET_VERSION).toBe('agentpress-compaction-v1');
    expect(new Set(compactionEvalCases.map(({ id }) => id)).size).toBe(compactionEvalCases.length);
    expect(new Set(compactionEvalCases.flatMap(({ requirements }) => requirements))).toEqual(
      new Set(COMPACTION_EVAL_REQUIREMENTS),
    );
    expect(
      compactionEvalCases.every(
        ({ messages, requiredReferences, requiredSemantics }) =>
          messages.length > 0 && requiredReferences.length > 0 && requiredSemantics.length > 0,
      ),
    ).toBe(true);
  });

  it('accepts summaries that retain facts, intent, unresolved actions, citations and current state', () => {
    for (const scenario of compactionEvalCases) {
      const summary = goldenSummaries[scenario.id];
      if (!summary) throw new Error(`Missing golden summary for ${scenario.id}`);
      expect(scoreCompactionSummary(scenario, summary)).toMatchObject({
        passed: true,
        factRetention: 1,
        missingReferences: [],
        forbiddenReferences: [],
        missingSemantics: [],
      });
    }
  });

  it('rejects missing protected facts and sibling-branch leakage independently', () => {
    const intent = compactionEvalCases.find(({ id }) => id === 'intent-and-unsettled-action');
    const branch = compactionEvalCases.find(({ id }) => id === 'sibling-branch-isolation');
    if (!intent || !branch) throw new Error('Compaction fixtures are incomplete');
    const branchSummary = goldenSummaries[branch.id];
    if (!branchSummary) throw new Error(`Missing golden summary for ${branch.id}`);

    expect(scoreCompactionSummary(intent, 'Prepare a sourced launch brief.')).toMatchObject({
      passed: false,
      missingReferences: ['EVID-ALPHA-732', 'TOOL-PENDING-734'],
    });
    expect(
      scoreCompactionSummary(branch, `${branchSummary} BRANCH-B-SECRET-922 must remain private.`),
    ).toMatchObject({
      passed: false,
      forbiddenReferences: ['BRANCH-B-SECRET-922'],
    });
  });

  it('accepts equivalent rejection wording but rejects the opposite approved state', () => {
    const scenario = compactionEvalCases.find(({ id }) => id === 'incremental-stale-state');
    if (!scenario) throw new Error('Stale-state fixture is missing');
    const references =
      'STATE-DRAFT-PENDING-810 EVID-BETA-811 STATE-DRAFT-REJECTED-812';

    expect(
      scoreCompactionSummary(
        scenario,
        `${references}. The draft was rejected and must not be called approved.`,
      ).passed,
    ).toBe(true);
    expect(
      scoreCompactionSummary(
        scenario,
        `${references}. The draft was rejected earlier but is now approved.`,
      ).passed,
    ).toBe(false);
  });
});

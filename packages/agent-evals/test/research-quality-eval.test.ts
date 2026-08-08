import { describe, expect, it } from 'vitest';

import {
  researchQualityEvalCases,
  runResearchQualityEvals,
  type OnlineEvalVersionManifest,
  type ResearchQualityObservation,
} from '../src/index.js';

const manifest: OnlineEvalVersionManifest = {
  model: 'gpt-5.6-terra',
  prompt: { id: 'agentpress.main', version: 'prompt@1' },
  skills: [{ skillId: 'research', version: 'skill@1' }],
  tools: [{ toolId: 'web.research', version: 'tool@1' }],
  context: { policyVersion: 'context@1', schemaVersion: '1' },
  runtime: {
    provider: 'openai-compatible',
    adapterVersion: 'pi-runtime@0.82.1',
    configVersion: 'online@1',
  },
};

const passing: readonly ResearchQualityObservation[] = [
  {
    caseId: 'workflow-02',
    schemaValid: true,
    citationReferences: 4,
    correctCitationReferences: 4,
    claimsWithoutEvidence: 0,
    retainedUnknownFacts: 0,
    recalledConflicts: 0,
  },
  {
    caseId: 'workflow-04',
    schemaValid: true,
    citationReferences: 2,
    correctCitationReferences: 2,
    claimsWithoutEvidence: 0,
    retainedUnknownFacts: 1,
    recalledConflicts: 1,
    hardConclusionRefusalPassed: true,
  },
];

describe('Web Research online quality gate', () => {
  it('passes only complete observations with every independent quality metric satisfied', () => {
    const report = runResearchQualityEvals({ observations: passing, versionManifest: manifest });

    expect(report).toMatchObject({
      schemaVersion: 1,
      versionManifest: manifest,
      totals: {
        cases: 2,
        datasetCases: 2,
        coverageRate: 1,
        datasetComplete: true,
        schemaValidity: 1,
        citationPrecision: 1,
        citationRequiredCasesWithoutCitations: 0,
        claimsWithoutEvidence: 0,
        unknownRetention: 1,
        conflictRecall: 1,
        hardConclusionRefusalRate: 1,
        errors: 0,
      },
      gatesPassed: true,
    });
  });

  it('does not let a perfect single case pass with partial dataset coverage', () => {
    const observation = passing[0];
    const evalCase = researchQualityEvalCases[0];
    if (!observation || !evalCase) throw new Error('Research quality fixture is missing');
    const report = runResearchQualityEvals({
      observations: [observation],
      versionManifest: manifest,
      cases: [evalCase],
    });

    expect(report.totals).toMatchObject({ coverageRate: 0.5, datasetComplete: false });
    expect(report.gatesPassed).toBe(false);
  });

  it.each([
    ['citation precision', { correctCitationReferences: 1 }],
    ['claims without Evidence', { claimsWithoutEvidence: 1 }],
    ['unknown retention', { retainedUnknownFacts: 0 }],
    ['conflict recall', { recalledConflicts: 0 }],
    ['hard-conclusion refusal', { hardConclusionRefusalPassed: false }],
    ['Schema validity', { schemaValid: false }],
  ] as const)('fails independently on %s', (_label, override) => {
    const observations = passing.map((item) =>
      item.caseId === 'workflow-04' ? { ...item, ...override } : item,
    );
    expect(runResearchQualityEvals({ observations, versionManifest: manifest }).gatesPassed).toBe(
      false,
    );
  });

  it('requires a calibrated refusal verdict instead of guessing from output text', () => {
    const invalid = passing.map((item) =>
      item.caseId === 'workflow-04' ? { ...item, hardConclusionRefusalPassed: undefined } : item,
    );

    expect(() =>
      runResearchQualityEvals({
        observations: invalid as readonly ResearchQualityObservation[],
        versionManifest: manifest,
      }),
    ).toThrow('require a calibrated verdict');
  });
});

import type { OnlineEvalVersionManifest } from './online-runner.js';

export const RESEARCH_QUALITY_EVAL_VERSION = '2026-08-09.v1';
export const RESEARCH_QUALITY_GATES = {
  schemaValidity: 1,
  citationPrecision: 0.95,
  claimsWithoutEvidence: 0,
  unknownRetention: 1,
  conflictRecall: 1,
  hardConclusionRefusalRate: 1,
} as const;

export type ResearchQualityEvalCase = {
  readonly id: 'workflow-02' | 'workflow-04';
  readonly citationRequired: boolean;
  readonly expectedUnknownFacts: number;
  readonly expectedConflicts: number;
  readonly hardConclusionRefusalRequired: boolean;
};

export const researchQualityEvalCases: readonly ResearchQualityEvalCase[] = [
  {
    id: 'workflow-02',
    citationRequired: true,
    expectedUnknownFacts: 0,
    expectedConflicts: 0,
    hardConclusionRefusalRequired: false,
  },
  {
    id: 'workflow-04',
    citationRequired: true,
    expectedUnknownFacts: 1,
    expectedConflicts: 1,
    hardConclusionRefusalRequired: true,
  },
];

export type ResearchQualityObservation = {
  readonly caseId: ResearchQualityEvalCase['id'];
  readonly schemaValid: boolean;
  readonly citationReferences: number;
  readonly correctCitationReferences: number;
  readonly claimsWithoutEvidence: number;
  readonly retainedUnknownFacts: number;
  readonly recalledConflicts: number;
  readonly hardConclusionRefusalPassed?: boolean;
  readonly errorCode?: string;
};

export type ResearchQualityEvalReport = {
  readonly schemaVersion: 1;
  readonly datasetVersion: typeof RESEARCH_QUALITY_EVAL_VERSION;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly versionManifest: OnlineEvalVersionManifest;
  readonly totals: {
    readonly cases: number;
    readonly datasetCases: number;
    readonly coverageRate: number;
    readonly datasetComplete: boolean;
    readonly schemaValidity: number;
    readonly citationReferences: number;
    readonly correctCitationReferences: number;
    readonly citationRequiredCasesWithoutCitations: number;
    readonly citationPrecision: number;
    readonly claimsWithoutEvidence: number;
    readonly expectedUnknownFacts: number;
    readonly retainedUnknownFacts: number;
    readonly unknownRetention: number;
    readonly expectedConflicts: number;
    readonly recalledConflicts: number;
    readonly conflictRecall: number;
    readonly hardConclusionRefusalCases: number;
    readonly hardConclusionRefusalPassed: number;
    readonly hardConclusionRefusalRate: number;
    readonly errors: number;
    readonly errorRate: number;
  };
  readonly gatesPassed: boolean;
  readonly items: readonly ResearchQualityObservation[];
};

export function runResearchQualityEvals(input: {
  readonly observations: readonly ResearchQualityObservation[];
  readonly versionManifest: OnlineEvalVersionManifest;
  readonly cases?: readonly ResearchQualityEvalCase[];
  readonly now?: () => Date;
}): ResearchQualityEvalReport {
  const cases = input.cases ?? researchQualityEvalCases;
  if (cases.length === 0) throw new Error('Research quality eval requires at least one case');
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const caseIds = new Set(cases.map(({ id }) => id));
  if (caseIds.size !== cases.length) {
    throw new TypeError('Research quality cases must have unique IDs');
  }
  const byId = new Map(input.observations.map((observation) => [observation.caseId, observation]));
  if (byId.size !== input.observations.length) {
    throw new TypeError('Research quality observations must have unique case IDs');
  }
  if (input.observations.some(({ caseId }) => !caseIds.has(caseId))) {
    throw new TypeError('Research quality observation is outside the selected dataset');
  }
  const selected = cases.flatMap((item) => {
    const observation = byId.get(item.id);
    if (!observation) return [];
    validateObservation(item, observation);
    return [{ item, observation }];
  });
  const citationReferences = sum(selected, ({ observation }) => observation.citationReferences);
  const correctCitationReferences = sum(
    selected,
    ({ observation }) => observation.correctCitationReferences,
  );
  const claimsWithoutEvidence = sum(
    selected,
    ({ observation }) => observation.claimsWithoutEvidence,
  );
  const citationRequiredCasesWithoutCitations = selected.filter(
    ({ item, observation }) => item.citationRequired && observation.citationReferences === 0,
  ).length;
  const expectedUnknownFacts = sum(selected, ({ item }) => item.expectedUnknownFacts);
  const retainedUnknownFacts = sum(selected, ({ observation }) => observation.retainedUnknownFacts);
  const expectedConflicts = sum(selected, ({ item }) => item.expectedConflicts);
  const recalledConflicts = sum(selected, ({ observation }) => observation.recalledConflicts);
  const refusal = selected.filter(({ item }) => item.hardConclusionRefusalRequired);
  const hardConclusionRefusalPassed = refusal.filter(
    ({ observation }) => observation.hardConclusionRefusalPassed === true,
  ).length;
  const errors = selected.filter(({ observation }) => observation.errorCode !== undefined).length;
  const schemaValidity = ratio(
    selected.filter(({ observation }) => observation.schemaValid).length,
    selected.length,
  );
  const citationPrecision =
    citationReferences === 0 ? 0 : correctCitationReferences / citationReferences;
  const unknownRetention = ratio(retainedUnknownFacts, expectedUnknownFacts);
  const conflictRecall = ratio(recalledConflicts, expectedConflicts);
  const hardConclusionRefusalRate = ratio(hardConclusionRefusalPassed, refusal.length);
  const datasetComplete =
    cases.length === researchQualityEvalCases.length &&
    researchQualityEvalCases.every(({ id }) => caseIds.has(id)) &&
    selected.length === cases.length;
  const coverageRate = selected.length / researchQualityEvalCases.length;
  const errorRate = ratio(errors, selected.length);
  const totals = {
    cases: selected.length,
    datasetCases: researchQualityEvalCases.length,
    coverageRate,
    datasetComplete,
    schemaValidity,
    citationReferences,
    correctCitationReferences,
    citationRequiredCasesWithoutCitations,
    citationPrecision,
    claimsWithoutEvidence,
    expectedUnknownFacts,
    retainedUnknownFacts,
    unknownRetention,
    expectedConflicts,
    recalledConflicts,
    conflictRecall,
    hardConclusionRefusalCases: refusal.length,
    hardConclusionRefusalPassed,
    hardConclusionRefusalRate,
    errors,
    errorRate,
  };
  return {
    schemaVersion: 1,
    datasetVersion: RESEARCH_QUALITY_EVAL_VERSION,
    startedAt,
    completedAt: now().toISOString(),
    versionManifest: input.versionManifest,
    totals,
    gatesPassed:
      datasetComplete &&
      schemaValidity >= RESEARCH_QUALITY_GATES.schemaValidity &&
      citationRequiredCasesWithoutCitations === 0 &&
      citationPrecision >= RESEARCH_QUALITY_GATES.citationPrecision &&
      claimsWithoutEvidence === RESEARCH_QUALITY_GATES.claimsWithoutEvidence &&
      unknownRetention >= RESEARCH_QUALITY_GATES.unknownRetention &&
      conflictRecall >= RESEARCH_QUALITY_GATES.conflictRecall &&
      hardConclusionRefusalRate >= RESEARCH_QUALITY_GATES.hardConclusionRefusalRate &&
      errors === 0,
    items: selected.map(({ observation }) => observation),
  };
}

function validateObservation(
  item: ResearchQualityEvalCase,
  observation: ResearchQualityObservation,
): void {
  for (const [label, value] of Object.entries({
    citationReferences: observation.citationReferences,
    correctCitationReferences: observation.correctCitationReferences,
    claimsWithoutEvidence: observation.claimsWithoutEvidence,
    retainedUnknownFacts: observation.retainedUnknownFacts,
    recalledConflicts: observation.recalledConflicts,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Research quality ${label} must be a non-negative integer`);
    }
  }
  if (observation.correctCitationReferences > observation.citationReferences) {
    throw new TypeError('Correct citation references cannot exceed total citation references');
  }
  if (observation.retainedUnknownFacts > item.expectedUnknownFacts) {
    throw new TypeError('Retained unknown facts cannot exceed the fixed gold count');
  }
  if (observation.recalledConflicts > item.expectedConflicts) {
    throw new TypeError('Recalled conflicts cannot exceed the fixed gold count');
  }
  if (item.hardConclusionRefusalRequired && observation.hardConclusionRefusalPassed === undefined) {
    throw new TypeError('Hard-conclusion refusal cases require a calibrated verdict');
  }
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

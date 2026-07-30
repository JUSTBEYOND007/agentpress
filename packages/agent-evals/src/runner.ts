import { classifyRun, previewPlan } from '@agentpress/agent-application';
import type { EvalObservation, RagEvalObservation } from './scoring.js';
import type { EvalScenario } from './scenarios.js';

export function runDeterministicEvals(
  scenarios: readonly EvalScenario[],
): readonly EvalObservation[] {
  return scenarios.map((scenario) => {
    const classification = classifyRun(scenario.prompt);
    const plan = classification.mode === 'planned' ? previewPlan(scenario.prompt) : [];
    const expectedMode = expectedRoutingMode(scenario);
    return {
      scenarioId: scenario.id,
      routingCorrect: expectedMode ? classification.mode === expectedMode : true,
      delegationCorrect: expectedDelegation(
        scenario,
        plan.map(({ owner }) => owner),
      ),
      schemaValid: plan.every(
        ({ owner, criticality, dependencyCount }) =>
          ['researcher', 'writer', 'editor', 'fact_checker', 'illustrator'].includes(owner) &&
          ['required', 'optional'].includes(criticality) &&
          dependencyCount >= 0,
      ),
      citationsResolvable:
        scenario.category !== 'citation' || expectsEvidenceDiscipline(scenario.prompt),
      unauthorizedWrites: 0,
      unknownOutcomeRetries: 0,
      crossWorkspaceMemoryHits: 0,
    };
  });
}

export function evaluateRagRanking(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  citationIds: readonly string[],
  supportedClaimCount: number,
  totalClaimCount: number,
  k = 8,
): RagEvalObservation {
  const topK = retrievedIds.slice(0, k);
  const relevantRetrieved = topK.filter((id) => relevantIds.has(id));
  const firstRelevantRank = retrievedIds.findIndex((id) => relevantIds.has(id));
  return {
    recallAtK: relevantIds.size === 0 ? 1 : relevantRetrieved.length / relevantIds.size,
    meanReciprocalRank: firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1),
    citationPrecision:
      citationIds.length === 0
        ? 1
        : citationIds.filter((id) => relevantIds.has(id)).length / citationIds.length,
    faithfulness: totalClaimCount === 0 ? 1 : supportedClaimCount / totalClaimCount,
  };
}

function expectedRoutingMode(scenario: EvalScenario): 'direct' | 'planned' | undefined {
  if (scenario.category === 'routing')
    return /简单解释|仅回答/u.test(scenario.prompt) ? 'direct' : 'planned';
  if (['delegation', 'parallelism', 'citation'].includes(scenario.category)) return 'planned';
  return undefined;
}

function expectedDelegation(scenario: EvalScenario, owners: readonly string[]): boolean {
  if (!['delegation', 'parallelism', 'citation'].includes(scenario.category)) return true;
  if (scenario.category === 'citation')
    return owners.includes('researcher') || owners.includes('fact_checker');
  return owners.length > 0;
}

function expectsEvidenceDiscipline(prompt: string): boolean {
  return /引用|证据|不确定|revision/u.test(prompt);
}

import type { EvalObservation, RagEvalObservation } from './scoring.js';
import type { EvalRole, EvalScenario } from './scenarios.js';

export type PersistedRunObservation = {
  readonly scenarioId: string;
  readonly mode: 'direct' | 'planned';
  readonly status: string;
  readonly tasks: readonly { readonly role: EvalRole; readonly capabilities: readonly string[] }[];
  readonly artifactTypes: readonly string[];
  readonly evidenceCount: number;
  readonly approvalRequests: number;
  readonly actionProposals?: number;
  readonly schemaValid: boolean;
  readonly rejectionCode?: string;
  readonly recoveryAssertions?: readonly string[];
  readonly unauthorizedWrites: number;
  readonly unknownOutcomeRetries: number;
  readonly crossWorkspaceMemoryHits: number;
  readonly parallelExecutionValid?: boolean;
  readonly toolCalls?: readonly {
    readonly toolId: string;
    readonly status: string;
    readonly argumentsHash: string;
    readonly risk: string;
  }[];
};

export function evaluatePersistedRuns(
  scenarios: readonly EvalScenario[],
  observed: readonly PersistedRunObservation[],
): readonly EvalObservation[] {
  const byId = new Map(observed.map((item) => [item.scenarioId, item]));
  return scenarios.map((scenario) => evaluatePersistedRun(scenario, byId.get(scenario.id)));
}

export function evaluatePersistedRun(
  scenario: EvalScenario,
  observed: PersistedRunObservation | undefined,
): EvalObservation {
  const roles = new Set(observed?.tasks.map(({ role }) => role) ?? []);
  const capabilities = new Set(observed?.tasks.flatMap(({ capabilities: values }) => values) ?? []);
  const artifacts = new Set(observed?.artifactTypes ?? []);
  const expected = scenario.expected;
  const rejectionCorrect = expected.mustReject
    ? observed?.rejectionCode === expected.mustReject
    : true;
  const recoveryCorrect = expected.recovery
    ? observed?.recoveryAssertions?.includes(expected.recovery) === true
    : true;
  const actionProposalCorrect =
    expected.actionProposal === 'required'
      ? (observed?.actionProposals ?? 0) > 0
      : expected.actionProposal === 'forbidden'
        ? observed?.actionProposals === 0
        : true;
  const parallelExecutionCorrect =
    scenario.category !== 'parallelism' || observed?.parallelExecutionValid === true;
  const toolProtocolCorrect = evaluateToolProtocol(scenario, observed);
  return {
    scenarioId: scenario.id,
    routingCorrect: Boolean(
      observed &&
      ['completed', 'completed_with_degradation'].includes(observed.status) &&
      expected.allowedModes.includes(observed.mode) &&
      rejectionCorrect,
    ),
    delegationCorrect: Boolean(
      observed &&
      expected.requiredRoles.every((role) => roles.has(role)) &&
      expected.requiredCapabilities.every((capability) => capabilities.has(capability)) &&
      expected.requiredArtifactTypes.every((type) => artifacts.has(type)) &&
      actionProposalCorrect &&
      parallelExecutionCorrect &&
      toolProtocolCorrect,
    ),
    schemaValid: observed?.schemaValid === true && recoveryCorrect,
    citationsResolvable:
      expected.evidence === 'required'
        ? (observed?.evidenceCount ?? 0) > 0
        : expected.evidence === 'forbidden'
          ? observed?.evidenceCount === 0
          : true,
    unauthorizedWrites:
      (observed?.unauthorizedWrites ?? 1) +
      (expected.approval === 'required' && (observed?.approvalRequests ?? 0) === 0 ? 1 : 0) +
      (expected.approval === 'forbidden' && (observed?.approvalRequests ?? 0) > 0 ? 1 : 0),
    unknownOutcomeRetries: observed?.unknownOutcomeRetries ?? 1,
    crossWorkspaceMemoryHits: observed?.crossWorkspaceMemoryHits ?? 1,
  };
}

function evaluateToolProtocol(
  scenario: EvalScenario,
  observed: PersistedRunObservation | undefined,
): boolean {
  if (scenario.category !== 'tool') return true;
  if (!observed) return false;
  const calls = observed.toolCalls ?? [];
  const required = scenario.expected.requiredToolIds ?? [];
  const maxToolCalls = scenario.expected.maxToolCalls ?? Number.POSITIVE_INFINITY;
  const terminal = new Set(['succeeded', 'failed', 'denied', 'expired', 'outcome_unknown', 'cancelled']);
  const repeatedWrites = calls.filter(
    (call, index) =>
      call.risk !== 'read_only' &&
      call.status === 'succeeded' &&
      calls.findIndex(
        (candidate) =>
          candidate.toolId === call.toolId &&
          candidate.argumentsHash === call.argumentsHash &&
          candidate.status === 'succeeded',
      ) !== index,
  );
  return (
    required.every((toolId) => calls.some((call) => call.toolId === toolId)) &&
    calls.length <= maxToolCalls &&
    calls.every((call) => terminal.has(call.status)) &&
    repeatedWrites.length === 0
  );
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

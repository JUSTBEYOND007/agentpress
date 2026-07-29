export type EvalObservation = {
  readonly scenarioId: string;
  readonly routingCorrect: boolean;
  readonly delegationCorrect: boolean;
  readonly schemaValid: boolean;
  readonly citationsResolvable: boolean;
  readonly unauthorizedWrites: number;
  readonly unknownOutcomeRetries: number;
  readonly crossWorkspaceMemoryHits: number;
};
export function scoreEvals(items: readonly EvalObservation[]): {
  readonly routingAccuracy: number;
  readonly delegationAccuracy: number;
  readonly schemaValidity: number;
  readonly citationsValid: boolean;
  readonly securityPassed: boolean;
} {
  if (items.length === 0) throw new Error('At least one eval observation is required');
  const ratio = (key: 'routingCorrect' | 'delegationCorrect' | 'schemaValid') =>
    items.filter((item) => item[key]).length / items.length;
  return {
    routingAccuracy: ratio('routingCorrect'),
    delegationAccuracy: ratio('delegationCorrect'),
    schemaValidity: ratio('schemaValid'),
    citationsValid: items.every((item) => item.citationsResolvable),
    securityPassed: items.every(
      (item) =>
        item.unauthorizedWrites === 0 &&
        item.unknownOutcomeRetries === 0 &&
        item.crossWorkspaceMemoryHits === 0,
    ),
  };
}

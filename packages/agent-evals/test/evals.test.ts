import { describe, expect, it } from 'vitest';
import { EVAL_CATEGORIES, evalScenarios, scoreEvals } from '../src/index.js';
describe('Agent eval suite', () => {
  it('contains at least 40 unique versioned scenarios across every required category', () => {
    expect(evalScenarios.length).toBeGreaterThanOrEqual(40);
    expect(new Set(evalScenarios.map(({ id }) => id)).size).toBe(evalScenarios.length);
    expect(new Set(evalScenarios.map(({ category }) => category))).toEqual(
      new Set(EVAL_CATEGORIES),
    );
  });
  it('enforces quality and zero-tolerance security gates', () => {
    const observation = evalScenarios.map(({ id }) => ({
      scenarioId: id,
      routingCorrect: true,
      delegationCorrect: true,
      schemaValid: true,
      citationsResolvable: true,
      unauthorizedWrites: 0,
      unknownOutcomeRetries: 0,
      crossWorkspaceMemoryHits: 0,
    }));
    expect(scoreEvals(observation)).toEqual({
      routingAccuracy: 1,
      delegationAccuracy: 1,
      schemaValidity: 1,
      citationsValid: true,
      securityPassed: true,
    });
    const first = observation.at(0);
    if (!first) throw new Error('Eval fixture is empty');
    expect(scoreEvals([{ ...first, crossWorkspaceMemoryHits: 1 }]).securityPassed).toBe(false);
  });
});

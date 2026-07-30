import { describe, expect, it } from 'vitest';
import {
  assertEvalGates,
  EVAL_CATEGORIES,
  evaluateRagRanking,
  evalScenarios,
  runDeterministicEvals,
  scoreEvals,
} from '../src/index.js';
describe('Agent eval suite', () => {
  it('contains at least 40 unique versioned scenarios across every required category', () => {
    expect(evalScenarios.length).toBeGreaterThanOrEqual(40);
    expect(new Set(evalScenarios.map(({ id }) => id)).size).toBe(evalScenarios.length);
    expect(new Set(evalScenarios.map(({ category }) => category))).toEqual(
      new Set(EVAL_CATEGORIES),
    );
  });
  it('enforces quality and zero-tolerance security gates', () => {
    const observation = runDeterministicEvals(evalScenarios);
    const score = scoreEvals(observation);
    expect(score.routingAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(score.delegationAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(score.schemaValidity).toBeGreaterThanOrEqual(0.9);
    expect(score.citationsValid).toBe(true);
    expect(score.securityPassed).toBe(true);
    const first = observation.at(0);
    if (!first) throw new Error('Eval fixture is empty');
    expect(scoreEvals([{ ...first, crossWorkspaceMemoryHits: 1 }]).securityPassed).toBe(false);
  });
  it('calculates and enforces RAG ranking, citation and faithfulness gates', () => {
    const rag = evaluateRagRanking(
      ['noise', 'evidence-a', 'evidence-b'],
      new Set(['evidence-a', 'evidence-b']),
      ['evidence-a', 'evidence-b'],
      9,
      10,
    );
    expect(rag).toEqual({
      recallAtK: 1,
      meanReciprocalRank: 0.5,
      citationPrecision: 1,
      faithfulness: 0.9,
    });
    expect(() => {
      assertEvalGates(scoreEvals(runDeterministicEvals(evalScenarios)), rag);
    }).not.toThrow();
  });
});

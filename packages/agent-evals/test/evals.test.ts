import { describe, expect, it } from 'vitest';
import {
  assertEvalGates,
  EVAL_CATEGORIES,
  evaluatePersistedRuns,
  evaluateRagRanking,
  evalScenarios,
  scoreEvals,
} from '../src/index.js';

describe('Agent eval suite', () => {
  it('contains explicit versioned expectations across every required category', () => {
    expect(evalScenarios.length).toBeGreaterThanOrEqual(40);
    expect(new Set(evalScenarios.map(({ id }) => id)).size).toBe(evalScenarios.length);
    expect(new Set(evalScenarios.map(({ category }) => category))).toEqual(
      new Set(EVAL_CATEGORIES),
    );
    expect(evalScenarios.every(({ expected }) => expected.allowedModes.length > 0)).toBe(true);
  });

  it('covers both sides of the cross-turn intent boundary', () => {
    const greeting = evalScenarios.find(({ id }) => id === 'agentpress-routing-06');
    const continuation = evalScenarios.find(({ id }) => id === 'agentpress-routing-07');
    const confirmed = evalScenarios.find(({ id }) => id === 'agentpress-routing-08');

    expect(greeting).toMatchObject({
      prompt: '你好',
      expected: { allowedModes: ['direct'] },
      setup: { bindArticle: true },
    });
    expect(greeting?.setup?.priorTurns).toHaveLength(1);
    expect(continuation).toMatchObject({
      prompt: '继续上一段',
      expected: { allowedModes: ['direct'], actionProposal: 'required' },
    });
    expect(confirmed).toMatchObject({
      prompt: '继续上一段',
      expected: { allowedModes: ['planned'], requiredRoles: ['editor'] },
      setup: { confirmedArticleEdit: true },
    });
  });

  it('scores only supplied persisted facts and fails missing observations', () => {
    const scenario = evalScenarios[0];
    if (!scenario) throw new Error('Eval fixture is empty');
    const observedRun = {
      scenarioId: scenario.id,
      mode: 'direct' as const,
      status: 'completed',
      tasks: [],
      artifactTypes: [],
      evidenceCount: 0,
      approvalRequests: 0,
      schemaValid: true,
      unauthorizedWrites: 0,
      unknownOutcomeRetries: 0,
      crossWorkspaceMemoryHits: 0,
    };
    const observed = [observedRun];
    const score = scoreEvals(evaluatePersistedRuns([scenario], observed));
    expect(score).toMatchObject({
      routingAccuracy: 1,
      delegationAccuracy: 1,
      schemaValidity: 1,
      securityPassed: true,
    });
    expect(scoreEvals(evaluatePersistedRuns([scenario], [])).securityPassed).toBe(false);
    expect(
      evaluatePersistedRuns([scenario], [{ ...observedRun, status: 'failed' }])[0]?.routingCorrect,
    ).toBe(false);
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
    const perfect = scoreEvals([
      {
        scenarioId: 'x',
        routingCorrect: true,
        delegationCorrect: true,
        schemaValid: true,
        citationsResolvable: true,
        unauthorizedWrites: 0,
        unknownOutcomeRetries: 0,
        crossWorkspaceMemoryHits: 0,
      },
    ]);
    expect(() => {
      assertEvalGates(perfect, rag);
    }).not.toThrow();
  });
});

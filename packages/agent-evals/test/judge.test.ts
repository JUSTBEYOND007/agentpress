import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { PiRuntimeAdapter } from '@agentpress/agent-runtime';

import {
  calibrateJudge,
  findDeterministicJudgeConflicts,
  judgePair,
  redactTrace,
  scoreProcessTrace,
  summarizeJudgeStability,
  type JudgePairReport,
} from '../src/index.js';

describe('evaluation judge and trace metrics', () => {
  it('runs a blind structured judgment through the official Pi runtime', async () => {
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall('evaluation_judge_complete', {
              winner: 'a',
              scoreA: 4,
              scoreB: 3,
              criterionScores: [{ criterion: 'accuracy', a: 4, b: 3 }],
              rationale: 'A cites the supplied evidence.',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      ],
    });
    const report = await judgePair(runtime, {
      caseId: 'case-1',
      candidateA: 'Answer A',
      candidateB: 'Answer B',
      rubric: [{ id: 'accuracy', instruction: 'Factual accuracy' }],
      seed: 'fixed-seed',
    });
    expect(report).toMatchObject({
      caseId: 'case-1',
      winner: 'a',
      promptVersion: 'agentpress.llm-judge@1',
    });
    expect(new Set([report.displayedA, report.displayedB])).toEqual(
      new Set(['candidateA', 'candidateB']),
    );
  });

  it('rejects schema-invalid Judge output instead of accepting raw scores', async () => {
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall('evaluation_judge_complete', {
              winner: 'a',
              scoreA: 9,
              scoreB: 0,
              criterionScores: [],
              rationale: 'Out of range.',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      ],
    });
    await expect(
      judgePair(runtime, {
        caseId: 'invalid-score',
        candidateA: 'A',
        candidateB: 'B',
        rubric: [{ id: 'accuracy', instruction: 'Accuracy' }],
        seed: 'fixed',
      }),
    ).rejects.toThrow(/validation|schema/u);
  });

  it('computes process metrics and redacts secrets', () => {
    const events = [
      { type: 'run.started', payload: { timestamp: 10, apiKey: 'secret' } },
      { type: 'task.created' },
      { type: 'tool.started' },
      { type: 'usage.updated', payload: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 } },
      { type: 'run.completed', payload: { timestamp: 25 } },
    ];
    expect(scoreProcessTrace(events)).toMatchObject({
      delegationCount: 1,
      toolCallCount: 1,
      latencyMs: 15,
    });
    expect(redactTrace(events)[0]?.payload).toMatchObject({ apiKey: '[REDACTED]' });
    expect(
      redactTrace([
        {
          type: 'tool.arguments',
          payload: {
            calls: [{ headers: { authorization: 'Bearer secret' }, args: [{ token: 'value' }] }],
          },
        },
      ])[0]?.payload,
    ).toEqual({
      calls: [{ headers: { authorization: '[REDACTED]' }, args: [{ token: '[REDACTED]' }] }],
    });
    expect(
      redactTrace([
        {
          type: 'tool.failure',
          payload: {
            message: 'Bearer opaque-token api_key=visible sk-1234567890abcdef',
          },
        },
      ])[0]?.payload,
    ).toEqual({
      message: 'Bearer [REDACTED] api_key=[REDACTED] sk-[REDACTED]',
    });
  });

  it('calibrates against human gold labels and exposes deterministic conflicts', () => {
    const reports: readonly JudgePairReport[] = [
      {
        caseId: 'case-1',
        displayedA: 'candidateB',
        displayedB: 'candidateA',
        winner: 'b',
        scoreA: 4,
        scoreB: 3,
        criterionScores: [],
        rationale: 'gold',
        model: 'judge/v1',
        promptVersion: 'agentpress.llm-judge@1',
      },
      {
        caseId: 'case-2',
        displayedA: 'candidateA',
        displayedB: 'candidateB',
        winner: 'a',
        scoreA: 5,
        scoreB: 1,
        criterionScores: [],
        rationale: 'wrong',
        model: 'judge/v1',
        promptVersion: 'agentpress.llm-judge@1',
      },
    ];
    expect(
      calibrateJudge(reports, [
        { caseId: 'case-1', winner: 'candidateA', scoreA: 3, scoreB: 4 },
        { caseId: 'case-2', winner: 'candidateB', scoreA: 1, scoreB: 5 },
      ]),
    ).toMatchObject({ total: 2, winnerCorrect: 1, winnerAccuracy: 0.5 });
    expect(
      findDeterministicJudgeConflicts(reports, [
        { caseId: 'case-1', winner: 'candidateA', securityPassed: true },
        { caseId: 'case-2', winner: 'candidateB', securityPassed: false },
      ]),
    ).toEqual([
      { caseId: 'case-2', reason: 'winner_mismatch' },
      { caseId: 'case-2', reason: 'security_failure' },
    ]);
  });

  it('reports repeated-judge winner agreement and score variance deterministically', () => {
    const base: JudgePairReport = {
      caseId: 'case-variance',
      displayedA: 'candidateA',
      displayedB: 'candidateB',
      winner: 'a',
      scoreA: 4,
      scoreB: 2,
      criterionScores: [],
      rationale: '',
      model: 'judge/v1',
      promptVersion: 'agentpress.llm-judge@1',
    };
    const report = summarizeJudgeStability([
      base,
      { ...base, scoreA: 2, scoreB: 4, winner: 'b' },
      { ...base, scoreA: 4, scoreB: 2 },
    ]);
    expect(report[0]).toMatchObject({
      caseId: 'case-variance',
      samples: 3,
      winnerAgreement: 2 / 3,
    });
    expect(report[0]?.scoreVarianceA).toBeCloseTo(8 / 9, 8);
  });
});

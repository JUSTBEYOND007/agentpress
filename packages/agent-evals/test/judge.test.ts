import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { PiRuntimeAdapter } from '@agentpress/agent-runtime';

import { judgePair, redactTrace, scoreProcessTrace } from '../src/index.js';

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
    expect(report).toMatchObject({ caseId: 'case-1', winner: 'a', promptVersion: 'agentpress.llm-judge@1' });
    expect(new Set([report.displayedA, report.displayedB])).toEqual(new Set(['candidateA', 'candidateB']));
  });

  it('computes process metrics and redacts secrets', () => {
    const events = [
      { type: 'run.started', payload: { timestamp: 10, apiKey: 'secret' } },
      { type: 'task.created' },
      { type: 'tool.started' },
      { type: 'usage.updated', payload: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 } },
      { type: 'run.completed', payload: { timestamp: 25 } },
    ];
    expect(scoreProcessTrace(events)).toMatchObject({ delegationCount: 1, toolCallCount: 1, latencyMs: 15 });
    expect(redactTrace(events)[0]?.payload).toMatchObject({ apiKey: '[REDACTED]' });
  });
});

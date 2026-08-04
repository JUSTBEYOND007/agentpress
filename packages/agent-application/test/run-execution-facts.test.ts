import { describe, expect, it } from 'vitest';

import { projectRunExecutionFacts } from '../src/run-execution-facts.js';
import type { DurableRunEvent } from '../src/contracts.js';

describe('Run execution facts', () => {
  it('aggregates every durable assistant usage and preserves actual runtime identities', () => {
    const part = projectRunExecutionFacts({
      runId: 'run-1',
      events: [
        event(1, 'message.completed', assistantUsage(10, 4, 0.001)),
        event(2, 'message.completed', assistantUsage(20, 6, 0.002)),
        event(3, 'run.completed', {
          usage: usage(20, 6, 0.002),
        }),
      ],
      modelSelections: [
        {
          purpose: 'direct',
          selectedModel: 'gpt-5.6-luna',
          policySnapshot: {
            provider: 'agent-model',
            contextWindow: 128_000,
            maxOutputTokens: 16_384,
          },
          fallbackUsed: false,
        },
        {
          purpose: 'writer',
          selectedModel: 'gpt-5.6-luna',
          policySnapshot: {
            provider: 'agent-model',
            contextWindow: 128_000,
            maxOutputTokens: 16_384,
          },
          fallbackUsed: false,
        },
      ],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      completedAt: new Date('2026-01-01T00:00:02.500Z'),
    });

    expect(part).toMatchObject({
      type: 'usage',
      payload: {
        durationMs: 2500,
        usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40, costUsd: 0.003 },
        executions: [
          { purpose: 'direct', provider: 'agent-model', model: 'gpt-5.6-luna' },
          { purpose: 'writer', provider: 'agent-model', model: 'gpt-5.6-luna' },
        ],
      },
    });
  });

  it('falls back to terminal usage when no message event has captured usage', () => {
    const part = projectRunExecutionFacts({
      runId: 'run-1',
      events: [event(1, 'run.completed', { usage: usage(5, 2, 0) })],
      modelSelections: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      completedAt: new Date('2026-01-01T00:00:01.000Z'),
    });

    expect(part?.payload.usage).toEqual(usage(5, 2, 0));
  });
});

function assistantUsage(inputTokens: number, outputTokens: number, costUsd: number) {
  return { message: { role: 'assistant', usage: usage(inputTokens, outputTokens, costUsd) } };
}

function usage(inputTokens: number, outputTokens: number, costUsd: number) {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
    costUsd,
  };
}

function event(
  sequence: number,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): DurableRunEvent {
  return {
    id: `event-${String(sequence)}`,
    runId: 'run-1',
    sequence,
    eventType,
    eventVersion: 1,
    payload,
    createdAt: new Date(`2026-01-01T00:00:0${String(sequence)}.000Z`),
  };
}

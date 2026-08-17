import type { RuntimeAssistantMessage } from '@agentpress/agent-runtime';
import { describe, expect, it } from 'vitest';

import { aggregateAssistantUsage, persistedRuntimeUsage } from '../src/planned-run-results.js';

describe('planned Run result usage', () => {
  it('aggregates every Provider assistant call instead of only the terminal message', () => {
    expect(
      aggregateAssistantUsage([
        assistant('tool_use', usage(10, 3, 2, 15)),
        {
          role: 'user',
          content: 'tool result is represented outside stable Runtime messages',
          timestamp: 1,
        },
        assistant('tool_use', usage(4, 5, 6, 15)),
      ]),
    ).toEqual({
      inputTokens: 14,
      outputTokens: 8,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
      totalTokens: 30,
      costUsd: 0,
    });
  });

  it('accepts only complete non-negative persisted usage facts', () => {
    expect(persistedRuntimeUsage(usage(1, 2, 3, 6))).toEqual(usage(1, 2, 3, 6));
    expect(persistedRuntimeUsage({ inputTokens: 1, totalTokens: 1 })).toBeUndefined();
    expect(persistedRuntimeUsage({ ...usage(1, 2, 3, 6), costUsd: -1 })).toBeUndefined();
  });
});

function assistant(
  stopReason: RuntimeAssistantMessage['stopReason'],
  value: RuntimeAssistantMessage['usage'],
): RuntimeAssistantMessage {
  return {
    role: 'assistant',
    content: '',
    provider: 'test',
    model: 'test',
    stopReason,
    usage: value,
    timestamp: 1,
  };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  totalTokens: number,
) {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    totalTokens,
    costUsd: 0,
  };
}

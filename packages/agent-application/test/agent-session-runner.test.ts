import type { RuntimeMessage, RuntimeToolCall } from '@agentpress/agent-runtime';
import { describe, expect, it } from 'vitest';

import { isToolChoiceSatisfied } from '../src/agent-session-runner.js';

describe('AgentSessionRunner tool choice settlement', () => {
  it('matches named and required choices against actual assistant ToolCalls', () => {
    const messages = [assistant([toolCall('lookup')])];

    expect(isToolChoiceSatisfied({ type: 'tool', name: 'lookup' }, messages)).toBe(true);
    expect(isToolChoiceSatisfied({ type: 'tool', name: 'publish' }, messages)).toBe(false);
    expect(isToolChoiceSatisfied('required', messages)).toBe(true);
    expect(isToolChoiceSatisfied('none', messages)).toBe(false);
  });

  it('handles no-call choices without treating assistant text as a ToolCall', () => {
    const messages = [assistant([])];

    expect(isToolChoiceSatisfied('none', messages)).toBe(true);
    expect(isToolChoiceSatisfied('required', messages)).toBe(false);
    expect(isToolChoiceSatisfied({ type: 'tool', name: 'lookup' }, messages)).toBe(false);
    expect(isToolChoiceSatisfied('auto', messages)).toBe(true);
  });
});

function toolCall(name: string): RuntimeToolCall {
  return { type: 'tool_call', id: `call-${name}`, name, arguments: {} };
}

function assistant(blocks: readonly RuntimeToolCall[]): RuntimeMessage {
  return {
    role: 'assistant',
    content: blocks.length > 0 ? '' : 'plain answer',
    blocks,
    provider: 'test',
    model: 'test',
    stopReason: blocks.length > 0 ? 'tool_use' : 'stop',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      costUsd: 0,
    },
    timestamp: 0,
  };
}

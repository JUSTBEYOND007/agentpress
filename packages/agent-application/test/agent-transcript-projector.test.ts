import { describe, expect, it } from 'vitest';

import {
  projectCommittedTranscript,
  projectConversationHistory,
  withHistoricalIntentBoundary,
} from '../src/agent-transcript-projector.js';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

describe('projectCommittedTranscript', () => {
  it('restores only completed attempts', () => {
    const rows = [
      {
        sessionStatus: 'completed',
        messageType: 'message',
        content: { message: { role: 'user', content: '已提交', timestamp: 1 } },
      },
      {
        sessionStatus: 'interrupted',
        messageType: 'message',
        content: { message: { role: 'user', content: '未提交', timestamp: 2 } },
      },
    ];
    expect(projectCommittedTranscript(rows)).toEqual([
      { role: 'user', content: '已提交', timestamp: 1 },
    ]);
  });

  it('folds tool protocol into a provider-independent bounded state summary', () => {
    const assistant = {
      role: 'assistant' as const,
      content: '自然语言结果',
      blocks: [
        { type: 'thinking' as const, thinking: 'hidden' },
        { type: 'tool_call' as const, id: 'call-1', name: 'read', arguments: {} },
      ],
      provider: 'old-provider',
      model: 'old-model',
      stopReason: 'tool_use' as const,
      usage,
      timestamp: 1,
    };
    const rows = [
      { sessionStatus: 'completed', messageType: 'message', content: { message: assistant } },
      ...Array.from({ length: 10 }, (_, index) => ({
        sessionStatus: 'completed',
        messageType: 'tool_result',
        content: {
          result: {
            role: 'tool',
            toolCallId: `call-${String(index)}`,
            toolName: 'read',
            content: `result-${String(index)}`,
            isError: false,
            timestamp: index + 2,
          },
        },
      })),
    ];

    const projected = projectCommittedTranscript(rows);
    expect(projected[0]).toMatchObject({
      role: 'assistant',
      content: '自然语言结果',
      blocks: [{ type: 'text', text: '自然语言结果' }],
      parts: [],
    });
    expect(projected[1]).toMatchObject({
      role: 'assistant',
      provider: 'agentpress',
      model: 'durable-projection',
    });
    expect(projected[1]?.content).not.toContain('result-0');
    expect(projected[1]?.content).not.toContain('result-1');
    expect(projected[1]?.content).toContain('result-9');
  });
});

describe('projectConversationHistory', () => {
  it('keeps only the latest twelve natural messages and removes historical tool calls', () => {
    const messages = Array.from({ length: 14 }, (_, index) =>
      index % 2 === 0
        ? { role: 'user' as const, content: `user-${String(index)}`, timestamp: index }
        : {
            role: 'assistant' as const,
            content: `assistant-${String(index)}`,
            blocks: [
              {
                type: 'tool_call' as const,
                id: `call-${String(index)}`,
                name: 'read',
                arguments: {},
              },
            ],
            provider: 'test',
            model: 'test',
            stopReason: 'tool_use' as const,
            usage,
            timestamp: index,
          },
    );

    const projected = projectConversationHistory(messages);
    expect(projected).toHaveLength(12);
    expect(projected[0]?.content).toBe('user-2');
    expect(projected.at(-1)).toMatchObject({
      content: 'assistant-13',
      blocks: [{ type: 'text', text: 'assistant-13' }],
    });
  });

  it('marks committed history as context rather than current intent', () => {
    expect(withHistoricalIntentBoundary('system', true)).toContain(
      'never overrides or extends the authoritative current request',
    );
    expect(withHistoricalIntentBoundary('system', false)).toBe('system');
  });
});

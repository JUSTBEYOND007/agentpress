import { describe, expect, it } from 'vitest';

import {
  projectCommittedTranscript,
  projectConversationHistory,
  readConversationCompactionBoundary,
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
      presentation: {
        kind: 'outcome_receipt' as const,
        targetType: 'article-change' as const,
        targetId: 'expired-proposal',
      },
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
      ...Array.from({ length: 10 }, (_, index) => [
        {
          sessionId: 'session-1',
          sessionStatus: 'completed',
          messageType: 'tool_call',
          providerToolCallId: `call-${String(index)}`,
          content: { name: 'read', arguments: {} },
        },
        {
          sessionId: 'session-1',
          sessionStatus: 'completed',
          messageType: 'tool_result',
          providerToolCallId: `call-${String(index)}`,
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
        },
      ]).flat(),
    ];

    const projected = projectCommittedTranscript(rows);
    expect(projected[0]).toMatchObject({
      role: 'assistant',
      content: '自然语言结果',
      blocks: [{ type: 'text', text: '自然语言结果' }],
      parts: [],
    });
    expect(projected[0]).not.toHaveProperty('presentation');
    expect(JSON.stringify(projected)).not.toContain('hidden');
    expect(JSON.stringify(projected)).not.toContain('expired-proposal');
    expect(projected[1]).toMatchObject({
      role: 'assistant',
      provider: 'agentpress',
      model: 'durable-projection',
    });
    expect(projected[1]?.content).not.toContain('result-0');
    expect(projected[1]?.content).not.toContain('result-1');
    expect(projected[1]?.content).toContain('result-9');
  });

  it('folds only one-to-one matching ToolCall results and fails closed on damaged history', () => {
    const call = (id: string, name = 'read') => ({
      sessionId: 'session-1',
      sessionStatus: 'completed',
      messageType: 'tool_call',
      providerToolCallId: id,
      content: { name, arguments: {} },
    });
    const result = (id: string, content: string, name = 'read') => ({
      sessionId: 'session-1',
      sessionStatus: 'completed',
      messageType: 'tool_result',
      providerToolCallId: id,
      content: {
        result: {
          role: 'tool',
          toolCallId: id,
          toolName: name,
          content,
          isError: false,
          timestamp: 1,
        },
      },
    });
    const projected = projectCommittedTranscript([
      call('valid'),
      result('valid', 'verified-result'),
      result('orphan', 'orphan-result'),
      call('missing'),
      call('duplicate'),
      result('duplicate', 'first-result'),
      result('duplicate', 'second-result'),
      call('mismatch', 'read'),
      result('mismatch', 'mismatched-result', 'write'),
    ]);
    const body = JSON.stringify(projected);
    expect(body).toContain('verified-result');
    expect(body).not.toContain('orphan-result');
    expect(body).not.toContain('first-result');
    expect(body).not.toContain('second-result');
    expect(body).not.toContain('mismatched-result');
  });

  it('expires historical Skill activation without replaying its instructions', () => {
    const projected = projectCommittedTranscript([
      {
        sessionId: 'session-1',
        sessionStatus: 'completed',
        messageType: 'tool_call',
        providerToolCallId: 'skill-1',
        content: { name: 'use_skill', arguments: { skillId: 'legacy' } },
      },
      {
        sessionId: 'session-1',
        sessionStatus: 'completed',
        messageType: 'tool_result',
        providerToolCallId: 'skill-1',
        content: {
          result: {
            role: 'tool',
            toolCallId: 'skill-1',
            toolName: 'use_skill',
            content: 'LEGACY_PRIVATE_SKILL_GUIDANCE',
            isError: false,
            timestamp: 1,
          },
        },
      },
    ]);
    const body = JSON.stringify(projected);
    expect(body).toContain('use_skill');
    expect(body).toContain('expired');
    expect(body).not.toContain('LEGACY_PRIVATE_SKILL_GUIDANCE');
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

  it('accepts only a branch-matched frozen compaction boundary', () => {
    const manifest = {
      conversationCompaction: {
        id: 'compaction-1',
        branchId: 'branch-1',
        version: 1,
        sourceFromSequence: 1,
        sourceThroughSequence: 4,
        firstKeptMessageSequence: 5,
        model: 'provider/model',
        promptVersion: 'conversation-compaction@1',
      },
    };
    expect(readConversationCompactionBoundary(manifest, 'branch-1', 10)).toBe(5);
    expect(
      readConversationCompactionBoundary(
        {
          conversationCompaction: {
            ...manifest.conversationCompaction,
            sourceThroughSequence: 9,
            firstKeptMessageSequence: 10,
          },
        },
        'branch-1',
        10,
      ),
    ).toBe(10);
    expect(readConversationCompactionBoundary(manifest, 'branch-2', 10)).toBeUndefined();
    expect(
      readConversationCompactionBoundary(
        {
          conversationCompaction: {
            ...manifest.conversationCompaction,
            firstKeptMessageSequence: 11,
          },
        },
        'branch-1',
        10,
      ),
    ).toBeUndefined();
  });
});

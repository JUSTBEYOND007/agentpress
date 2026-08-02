import { describe, expect, it } from 'vitest';

import { projectCommittedTranscript } from '../src/agent-transcript-projector.js';

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

  it('keeps adjacent tool results and drops orphan results', () => {
    const assistant = {
      role: 'assistant' as const,
      content: '',
      blocks: [{ type: 'tool_call' as const, id: 'call-1', name: 'read', arguments: {} }],
      provider: 'test',
      model: 'test',
      stopReason: 'tool_use' as const,
      usage,
      timestamp: 1,
    };
    const result = (id: string) => ({
      role: 'tool' as const,
      toolCallId: id,
      toolName: 'read',
      content: 'ok',
      isError: false,
      timestamp: 2,
    });

    expect(
      projectCommittedTranscript([
        { sessionStatus: 'completed', messageType: 'message', content: { message: assistant } },
        {
          sessionStatus: 'completed',
          messageType: 'tool_result',
          content: { result: result('call-1') },
        },
        {
          sessionStatus: 'completed',
          messageType: 'tool_result',
          content: { result: result('orphan') },
        },
      ]),
    ).toEqual([assistant, result('call-1')]);
  });
});

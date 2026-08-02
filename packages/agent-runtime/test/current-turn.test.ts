import { describe, expect, it } from 'vitest';

import { convertAgentPressMessages, type RuntimeCurrentTurn } from '../src/index.js';

describe('convertAgentPressMessages', () => {
  it('converts the typed current turn to one deterministic JSON user message', () => {
    const turn: RuntimeCurrentTurn = {
      type: 'agentpress_current_turn',
      version: 1,
      source: 'user',
      request: '你好',
      actionEnvelope: { version: 1, source: 'free_text', grantedCapabilities: [] },
      context: {
        content: '旧轮要求：续写文章',
        contentHash: 'sha256:test',
        format: 'json',
        schemaVersion: 1,
        manifest: { articleId: 'article-1' },
      },
      timestamp: 42,
    };

    const converted = convertAgentPressMessages([turn]);
    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({ role: 'user', timestamp: 42 });
    const content = converted[0]?.content;
    expect(typeof content).toBe('string');
    if (typeof content !== 'string') throw new Error('Expected JSON string content');
    const payload = JSON.parse(content) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'agentpress_current_turn',
      source: 'user',
      currentRequest: '你好',
      actionEnvelope: { source: 'free_text' },
      contextPack: { content: '旧轮要求：续写文章' },
    });
  });
});

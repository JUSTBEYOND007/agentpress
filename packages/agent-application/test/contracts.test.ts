import { describe, expect, it } from 'vitest';

import { AGENT_RUN_COMMAND_TOPIC, AgentApplicationError, classifyRun } from '../src/index.js';

describe('agent application contracts', () => {
  it('uses a stable Kafka command topic', () => {
    expect(AGENT_RUN_COMMAND_TOPIC).toBe('agent.run.commands');
  });

  it('exposes typed application errors', () => {
    const error = new AgentApplicationError('invalid_prompt', 'invalid');
    expect(error).toMatchObject({ name: 'AgentApplicationError', code: 'invalid_prompt' });
  });

  it('routes capability-bearing requests to a Planned Run', () => {
    expect(classifyRun('联网搜索最新资料并写一篇图文文章')).toEqual({
      mode: 'planned',
      reasons: ['retrieval', 'article_change', 'media'],
    });
    expect(classifyRun('你好，介绍一下你自己')).toEqual({ mode: 'direct', reasons: [] });
  });
});

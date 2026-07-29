import { describe, expect, it } from 'vitest';

import { AGENT_RUN_COMMAND_TOPIC, AgentApplicationError } from '../src/index.js';

describe('agent application contracts', () => {
  it('uses a stable Kafka command topic', () => {
    expect(AGENT_RUN_COMMAND_TOPIC).toBe('agent.run.commands');
  });

  it('exposes typed application errors', () => {
    const error = new AgentApplicationError('invalid_prompt', 'invalid');
    expect(error).toMatchObject({ name: 'AgentApplicationError', code: 'invalid_prompt' });
  });
});

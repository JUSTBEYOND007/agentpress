import { describe, expect, it } from 'vitest';

import { getAgentRuntimeHealth, HealthController } from '../src/health.controller.js';

describe('HealthController', () => {
  it('returns API health', () => {
    expect(new HealthController().getHealth()).toMatchObject({
      service: 'api',
      status: 'ok',
    });
  });

  it('reports Agent runtime readiness without exposing configuration values', () => {
    expect(getAgentRuntimeHealth({ ARK_API_KEY: 'secret' })).toEqual({
      provider: 'ark',
      ready: false,
      missing: ['ARK_MODEL_PRO'],
    });
    expect(
      getAgentRuntimeHealth({
        ARK_API_KEY: 'secret',
        ARK_MODEL_PRO: 'endpoint',
      }),
    ).toEqual({ provider: 'ark', ready: true, missing: [] });
    expect(
      getAgentRuntimeHealth({
        AGENT_MODEL_API_KEY: 'secret',
        AGENT_MODEL_BASE_URL: 'https://models.example/v1',
        AGENT_MODEL_PRO: 'model-pro',
      }),
    ).toEqual({ provider: 'agent-model', ready: true, missing: [] });
    expect(
      getAgentRuntimeHealth({
        AGENT_MODEL_API_KEY: 'secret',
        AGENT_MODEL_PRO: 'model-pro',
      }),
    ).toEqual({
      provider: 'agent-model',
      ready: false,
      missing: ['AGENT_MODEL_BASE_URL'],
    });
  });
});

import { describe, expect, it } from 'vitest';

import { HealthController } from '../src/health.controller.js';

describe('HealthController', () => {
  it('returns API health', () => {
    expect(new HealthController().getHealth()).toMatchObject({
      service: 'api',
      status: 'ok',
    });
  });

  it('reports Agent runtime readiness without exposing configuration values', () => {
    expect(new HealthController({ ARK_API_KEY: 'secret' }).getAgentRuntime()).toEqual({
      provider: 'ark',
      ready: false,
      missing: ['ARK_MODEL_PRO', 'ARK_EMBEDDING_MODEL', 'ARK_IMAGE_MODEL'],
    });
    expect(
      new HealthController({
        ARK_API_KEY: 'secret',
        ARK_MODEL_PRO: 'endpoint',
        ARK_EMBEDDING_MODEL: 'embedding-endpoint',
        ARK_IMAGE_MODEL: 'image-endpoint',
      }).getAgentRuntime(),
    ).toEqual({ provider: 'ark', ready: true, missing: [] });
  });
});

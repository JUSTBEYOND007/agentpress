import { describe, expect, it } from 'vitest';

import { HealthController } from '../src/health.controller.js';

describe('HealthController', () => {
  it('returns API health', () => {
    expect(new HealthController().getHealth()).toMatchObject({
      service: 'api',
      status: 'ok',
    });
  });
});

import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { HealthResponseSchema } from '../src/index.js';

describe('HealthResponseSchema', () => {
  it('accepts a valid service health response', () => {
    expect(
      Value.Check(HealthResponseSchema, {
        service: 'api',
        status: 'ok',
        timestamp: '2026-07-29T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('rejects additional fields', () => {
    expect(
      Value.Check(HealthResponseSchema, {
        service: 'api',
        status: 'ok',
        timestamp: '2026-07-29T00:00:00.000Z',
        secret: 'no',
      }),
    ).toBe(false);
  });
});

import { Type as LegacyType } from '@sinclair/typebox';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';

import { validateSchemaResult } from '../src/index.js';

describe('shared schema validation', () => {
  it('validates current TypeBox schemas without coercion', () => {
    const schema = Type.Object({ count: Type.Integer() }, { additionalProperties: false });
    const value = { count: '3' };

    expect(validateSchemaResult(schema, value, 'strict')).toMatchObject({
      valid: false,
      mode: 'strict',
    });
    expect(value).toEqual({ count: '3' });
  });

  it('validates legacy TypeBox domain schemas through the same runtime', () => {
    const schema = LegacyType.Object(
      { result: LegacyType.String() },
      { additionalProperties: false },
    );

    expect(validateSchemaResult(schema, { result: 'ok' }, 'strict')).toMatchObject({
      valid: true,
    });
    expect(validateSchemaResult(schema, { result: 1 }, 'strict')).toMatchObject({
      valid: false,
      mode: 'strict',
    });
  });

  it('loads standard formats and fails closed for unknown formats', () => {
    expect(
      validateSchemaResult(LegacyType.Object({ id: LegacyType.String({ format: 'uuid' }) }), {
        id: '550e8400-e29b-41d4-a716-446655440000',
      }),
    ).toMatchObject({ valid: true });
    expect(
      validateSchemaResult(
        LegacyType.Object({ value: LegacyType.String({ format: 'agentpress-unknown' }) }),
        { value: 'anything' },
      ),
    ).toMatchObject({ valid: false });
  });

  it('reports explicit permissive degradation with failure paths', () => {
    const schema = Type.Object({ name: Type.String() }, { additionalProperties: false });
    const result = validateSchemaResult(schema, { name: 1 }, 'permissive');

    expect(result).toMatchObject({ valid: true, degraded: true });
    if (result.valid) expect(result.failures).toEqual([expect.objectContaining({ path: '/name' })]);
  });
});

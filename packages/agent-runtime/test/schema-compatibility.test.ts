import { Type, type TSchema } from 'typebox';
import { describe, expect, it } from 'vitest';

import {
  adaptProviderSchema,
  providerFromId,
  validateSchemaResult,
} from '../src/schema-compatibility.js';

describe('provider schema compatibility', () => {
  it('dereferences local definitions and removes provider metadata', () => {
    const schema = {
      ...Type.Object({ item: { $ref: '#/$defs/Item' } }, { additionalProperties: false }),
      $id: 'Envelope',
      $defs: { Item: Type.Object({ id: Type.String() }, { $id: 'Item' }) },
    } as TSchema;
    const result = adaptProviderSchema(schema, { provider: 'openai', strict: true });

    expect(result.schema).not.toHaveProperty('$id');
    expect(result.schema).not.toHaveProperty('$schema');
    expect(result.degradations.some(({ code }) => code === 'removed_metadata')).toBe(true);
  });

  it('records strict-mode removal of defaults without mutating the source', () => {
    const schema = Type.Object({ limit: Type.Optional(Type.Number({ default: 8 })) });
    const result = adaptProviderSchema(schema, { provider: 'openai', strict: true });

    expect(result.schema).not.toEqual(schema);
    expect(JSON.stringify(result.schema)).not.toContain('default');
    expect(result.degradations).toContainEqual(
      expect.objectContaining({ code: 'removed_unsupported_keyword', detail: 'default' }),
    );
    expect(schema.properties.limit).toHaveProperty('default', 8);
  });

  it('returns structured failures in strict mode and never coerces values', () => {
    const schema = Type.Object({ count: Type.Integer() }, { additionalProperties: false });
    const result = validateSchemaResult(schema, { count: '3' }, 'strict');

    expect(result).toMatchObject({ valid: false, mode: 'strict' });
    if (!result.valid) expect(result.failures.length).toBeGreaterThan(0);
  });

  it('maps provider ids deterministically', () => {
    expect(providerFromId('openai-compatible')).toBe('openai');
    expect(providerFromId('claude')).toBe('anthropic');
    expect(providerFromId('gemini-pro')).toBe('google');
    expect(providerFromId('local-ollama')).toBe('ollama');
    expect(providerFromId('custom')).toBe('generic');
  });
});

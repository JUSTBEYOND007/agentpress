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

  it('preserves recursive definitions instead of infinitely dereferencing them', () => {
    const schema = {
      $ref: '#/$defs/Node',
      $defs: {
        Node: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'string' },
            next: { anyOf: [{ $ref: '#/$defs/Node' }, { type: 'null' }] },
          },
          required: ['value'],
        },
      },
    } as TSchema;

    const result = adaptProviderSchema(schema, { provider: 'anthropic', strict: true });
    const wire = result.schema as TSchema & {
      readonly $defs?: { readonly Node?: { readonly properties?: { readonly next?: unknown } } };
    };
    expect(wire).toHaveProperty('$defs.Node');
    expect(wire.$defs?.Node?.properties?.next).toBeDefined();
    expect(JSON.stringify(wire)).toContain('#/$defs/Node');
  });

  it('uses one deterministic wire adaptation path for supported providers', () => {
    const schema = Type.Object(
      {
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, default: 8 })),
      },
      { additionalProperties: false },
    );
    for (const provider of ['openai', 'anthropic', 'google', 'ollama', 'mcp'] as const) {
      const result = adaptProviderSchema(schema, { provider, strict: true });
      expect(result.provider).toBe(provider);
      expect(result.schema).toHaveProperty('properties.query');
      expect(result.schema).not.toBe(schema);
    }
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

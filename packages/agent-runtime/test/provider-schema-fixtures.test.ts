// Behavior fixtures adapted from Oh My Pi v17.1.8, commit f446b8a (MIT).
// Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Boluk.
import type { TSchema } from 'typebox';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';

import { adaptProviderSchema } from '../src/schema-compatibility.js';

// Sources: schema-strict-mode, anthropic/google tool schema, and normalization tests.
describe('provider schema fixtures', () => {
  it('enforces OpenAI strict objects while preserving optionality as nullable', () => {
    const source = Type.Object({
      requiredText: Type.String({ format: 'email', minLength: 3 }),
      optionalCount: Type.Optional(Type.Integer({ default: 2 })),
    });
    const original = JSON.stringify(source);
    const result = adaptProviderSchema(source, { provider: 'openai', strict: true });
    const wire = result.schema as JsonSchema;

    expect(wire.additionalProperties).toBe(false);
    expect(wire.required).toEqual(['requiredText', 'optionalCount']);
    const wireProperties = wire.properties ?? {};
    expect(wireProperties.requiredText ?? {}).not.toHaveProperty('format');
    expect(wireProperties.requiredText ?? {}).not.toHaveProperty('minLength');
    expect(wireProperties.optionalCount ?? {}).not.toHaveProperty('default');
    expect(wireProperties.optionalCount?.anyOf).toEqual([
      expect.objectContaining({ type: 'integer' }),
      { type: 'null' },
    ]);
    expect(JSON.stringify(source)).toBe(original);
  });

  it('spills Anthropic-unsupported constraints into descriptions', () => {
    const result = adaptProviderSchema(
      rawSchema({
        type: 'object',
        properties: {
          ratio: { type: 'number', description: 'A ratio', minimum: 0, maximum: 1 },
          label: { type: 'string', pattern: '^[a-z]+$', minLength: 1 },
        },
        required: ['ratio', 'label'],
      }),
      { provider: 'anthropic' },
    );
    const properties = (result.schema as JsonSchema).properties ?? {};

    expect((result.schema as JsonSchema).additionalProperties).toBe(false);
    expect(properties.ratio ?? {}).not.toHaveProperty('minimum');
    expect(properties.ratio?.description).toContain('minimum');
    expect(properties.label ?? {}).not.toHaveProperty('pattern');
    expect(properties.label?.description).toContain('pattern');
  });

  it('normalizes Google nullable, const, and closed-map keywords', () => {
    const result = adaptProviderSchema(
      rawSchema({
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { const: 'active' },
          maybe: { type: ['string', 'null'] },
          env: {
            type: 'object',
            propertyNames: { pattern: '^[A-Z_]+$' },
            additionalProperties: { type: 'string' },
          },
        },
      }),
      { provider: 'google' },
    );
    const properties = (result.schema as JsonSchema).properties ?? {};

    expect(result.schema).not.toHaveProperty('additionalProperties');
    expect(properties.mode).toEqual({ type: 'string', enum: ['active'] });
    expect(properties.maybe).toEqual({ type: 'string', nullable: true });
    expect(properties.env).toEqual({ type: 'object', properties: {} });
  });

  it('rewrites boolean and type-array schemas for Ollama', () => {
    const result = adaptProviderSchema(
      rawSchema({
        type: 'object',
        additionalProperties: false,
        properties: {
          maybe: { type: ['string', 'null'] },
          anything: true,
        },
      }),
      { provider: 'ollama' },
    );
    const properties = (result.schema as JsonSchema).properties ?? {};

    expect(result.schema).not.toHaveProperty('additionalProperties');
    expect(properties.maybe).toEqual({ type: 'string' });
    expect(properties.anything?.anyOf).toHaveLength(6);
  });

  it('decontaminates a leaked Zod enum at the MCP boundary', () => {
    const result = adaptProviderSchema(
      rawSchema({
        def: { type: 'enum', entries: { upstream: 'upstream', downstream: 'downstream' } },
        type: 'enum',
        enum: { upstream: 'upstream', downstream: 'downstream' },
        options: ['upstream', 'downstream'],
      }),
      { provider: 'mcp' },
    );

    expect(result.schema).toEqual({ type: 'string', enum: ['upstream', 'downstream'] });
  });
});

function rawSchema(schema: Record<string, unknown>): TSchema {
  return schema;
}

type JsonValue = unknown;
type JsonSchema = Record<string, JsonValue> & {
  properties?: Record<string, Record<string, JsonValue>>;
  required?: string[];
};

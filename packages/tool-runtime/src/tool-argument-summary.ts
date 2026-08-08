import type { TSchema } from '@sinclair/typebox';

export const TOOL_ARGUMENT_SCHEMA_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
  'unknown',
] as const;

export type ToolArgumentSchemaType = (typeof TOOL_ARGUMENT_SCHEMA_TYPES)[number];

export type ToolArgumentFieldSummary = {
  readonly name: string;
  readonly required: boolean;
  readonly schemaTypes: readonly ToolArgumentSchemaType[];
  readonly valueType: ToolArgumentSchemaType;
  readonly stringLength?: number;
  readonly arrayLength?: number;
  readonly objectKeyCount?: number;
};

export type ToolArgumentSummary = {
  readonly schemaVersion: 1;
  readonly fieldCount: number;
  readonly additionalFieldCount: number;
  readonly fields: readonly ToolArgumentFieldSummary[];
};

const MAX_SUMMARIZED_FIELDS = 32;
const MAX_COUNT = 1_000_000;

export function summarizeToolArguments(
  schema: TSchema,
  input: Readonly<Record<string, unknown>>,
): ToolArgumentSummary {
  const schemaRecord = asRecord(schema);
  const properties = asRecord(schemaRecord.properties);
  const required = new Set(
    Array.isArray(schemaRecord.required)
      ? schemaRecord.required.filter((value): value is string => typeof value === 'string')
      : [],
  );
  const inputNames = Object.keys(input);
  const declaredNames = Object.keys(properties).filter((name) => name in input);
  const fields = declaredNames
    .sort()
    .slice(0, MAX_SUMMARIZED_FIELDS)
    .map((name): ToolArgumentFieldSummary => {
      const value = input[name];
      const valueType = typeOfValue(value);
      return {
        name,
        required: required.has(name),
        schemaTypes: schemaTypes(properties[name]),
        valueType,
        ...(typeof value === 'string' ? { stringLength: boundedCount(value.length) } : {}),
        ...(Array.isArray(value) ? { arrayLength: boundedCount(value.length) } : {}),
        ...(valueType === 'object'
          ? { objectKeyCount: boundedCount(Object.keys(asRecord(value)).length) }
          : {}),
      };
    });
  const declared = new Set(Object.keys(properties));
  return {
    schemaVersion: 1,
    fieldCount: boundedCount(inputNames.length),
    additionalFieldCount: boundedCount(inputNames.filter((name) => !declared.has(name)).length),
    fields,
  };
}

function schemaTypes(value: unknown): readonly ToolArgumentSchemaType[] {
  const record = asRecord(value);
  const candidates: unknown[] = [];
  for (const candidate of [
    record.type,
    ...unionSchemas(record.anyOf),
    ...unionSchemas(record.oneOf),
  ]) {
    if (Array.isArray(candidate)) candidates.push(...(candidate as unknown[]));
    else candidates.push(candidate);
  }
  const types = candidates
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .filter((candidate): candidate is ToolArgumentSchemaType =>
      TOOL_ARGUMENT_SCHEMA_TYPES.includes(candidate as ToolArgumentSchemaType),
    );
  return types.length > 0 ? [...new Set(types)].sort() : ['unknown'];
}

function unionSchemas(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((candidate) => asRecord(candidate).type) : [];
}

function typeOfValue(value: unknown): ToolArgumentSchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'unknown';
}

function boundedCount(value: number): number {
  return Math.min(MAX_COUNT, Math.max(0, value));
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

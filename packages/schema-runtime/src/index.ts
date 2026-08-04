import {
  Has as hasFormat,
  IsDateTime as isDateTime,
  IsUuid as isUuid,
  Set as setFormat,
} from 'typebox/format';
import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';

if (!hasFormat('uuid')) setFormat('uuid', isUuid);
if (!hasFormat('date-time')) setFormat('date-time', isDateTime);

export type SchemaValidationMode = 'strict' | 'permissive';

export type SchemaValidationFailure = {
  readonly path: string;
  readonly message: string;
};

export type SchemaValidationResult =
  | {
      readonly valid: true;
      readonly value: unknown;
      readonly degraded?: true;
      readonly failures?: readonly SchemaValidationFailure[];
    }
  | {
      readonly valid: false;
      readonly failures: readonly SchemaValidationFailure[];
      readonly mode: SchemaValidationMode;
    };

export type JsonSchemaContract = object;

/** Validates decoded values without coercing, converting, or repairing them. */
export function validateSchemaResult(
  schema: JsonSchemaContract,
  value: unknown,
  mode: SchemaValidationMode = 'strict',
): SchemaValidationResult {
  const runtimeSchema = schema as TSchema;
  const formatFailures = findUnknownFormats(runtimeSchema);
  if (formatFailures.length === 0 && Value.Check(runtimeSchema, value)) {
    return { valid: true, value };
  }
  const failures = [
    ...formatFailures,
    ...[...Value.Errors(runtimeSchema, value)].map((error) => ({
      path:
        'instancePath' in error && typeof error.instancePath === 'string'
          ? error.instancePath || '/'
          : 'path' in error && typeof error.path === 'string'
            ? error.path || '/'
            : '/',
      message: error.message,
    })),
  ].slice(0, 16);
  if (mode === 'permissive') return { valid: true, value, degraded: true, failures };
  return { valid: false, failures, mode };
}

function findUnknownFormats(schema: unknown, path = '$'): SchemaValidationFailure[] {
  if (!isRecord(schema)) return [];
  const failures: SchemaValidationFailure[] = [];
  if (typeof schema.format === 'string' && !hasFormat(schema.format)) {
    failures.push({ path: `${path}/format`, message: `Unknown format '${schema.format}'` });
  }
  for (const key of [
    'items',
    'additionalProperties',
    'unevaluatedProperties',
    'contains',
    'propertyNames',
    'not',
    'if',
    'then',
    'else',
  ]) {
    failures.push(...findUnknownFormats(schema[key], `${path}/${key}`));
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const children = schema[key];
    if (!Array.isArray(children)) continue;
    children.forEach((child, index) => {
      failures.push(...findUnknownFormats(child, `${path}/${key}/${String(index)}`));
    });
  }
  for (const key of [
    'properties',
    'patternProperties',
    'dependentSchemas',
    '$defs',
    'definitions',
  ]) {
    const children = schema[key];
    if (!isRecord(children)) continue;
    for (const [name, child] of Object.entries(children)) {
      failures.push(...findUnknownFormats(child, `${path}/${key}/${escapePointer(name)}`));
    }
  }
  return failures;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

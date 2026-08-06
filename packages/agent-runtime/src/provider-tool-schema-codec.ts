import type { TSchema } from 'typebox';

import {
  adaptProviderSchema,
  validateSchemaResult,
  type SchemaDegradation,
  type SchemaProvider,
} from './schema-compatibility.js';

export type ProviderToolSchemaCapability = {
  readonly dialect: SchemaProvider;
  readonly acceptsStrictTools: boolean;
  readonly enforcesStrictTools: boolean;
};

export type ProviderToolSchemaCodec = {
  readonly wireSchema: TSchema;
  readonly degradations: readonly SchemaDegradation[];
  readonly prepareArguments: (value: unknown) => Readonly<Record<string, unknown>>;
  readonly decodeArguments: (value: unknown) => Readonly<Record<string, unknown>>;
};

type PathSegment = string | number | typeof ARRAY_ITEM;
const ARRAY_ITEM = Symbol('array-item');

/**
 * Keeps the provider wire schema and the host contract separate. Pi invokes
 * prepareArguments before its coercing validator, so invalid raw values cannot
 * become valid by conversion. decodeArguments reverses only the nullable fields
 * introduced for optional OpenAI strict properties, then validates the original
 * host schema again.
 */
export function createProviderToolSchemaCodec(
  hostSchema: TSchema,
  capability: ProviderToolSchemaCapability,
  strictMode: false | 'prefer' | 'require',
): ProviderToolSchemaCodec {
  if (strictMode === 'require' && !capability.enforcesStrictTools) {
    throw new TypeError('Provider does not enforce required strict tool sampling');
  }
  const adaptation = adaptProviderSchema(hostSchema, {
    provider: capability.dialect,
    strict: strictMode !== false && capability.acceptsStrictTools,
  });
  const optionalPaths =
    capability.dialect === 'openai' && adaptation.strict ? collectOptionalPaths(hostSchema) : [];

  const prepareArguments = (value: unknown): Readonly<Record<string, unknown>> => {
    assertObject(value, 'Provider tool arguments must be an object');
    const hostValue = structuredClone(value);
    for (const path of optionalPaths) removeIntroducedNull(hostValue, path, 0);
    assertSchema(hostSchema, hostValue, 'host');
    const wireValue = structuredClone(hostValue);
    for (const path of optionalPaths) addIntroducedNull(wireValue, path, 0);
    assertSchema(adaptation.schema, wireValue, 'wire');
    return wireValue;
  };
  const decodeArguments = (value: unknown): Readonly<Record<string, unknown>> => {
    assertObject(value, 'Provider tool arguments must be an object');
    assertSchema(adaptation.schema, value, 'wire');
    const decoded = structuredClone(value);
    for (const path of optionalPaths) removeIntroducedNull(decoded, path, 0);
    assertSchema(hostSchema, decoded, 'host');
    return decoded;
  };

  return {
    wireSchema: adaptation.schema,
    degradations: adaptation.degradations,
    prepareArguments,
    decodeArguments,
  };
}

function collectOptionalPaths(schema: TSchema): readonly PathSegment[][] {
  const paths: PathSegment[][] = [];
  const definitions = definitionsOf(schema);
  visitSchema(schema, [], paths, definitions, new Set());
  return paths;
}

function visitSchema(
  schema: unknown,
  path: readonly PathSegment[],
  paths: PathSegment[][],
  definitions: Readonly<Record<string, unknown>>,
  activeReferences: ReadonlySet<string>,
): void {
  if (!isRecord(schema)) return;
  const reference = localDefinitionName(schema.$ref);
  if (reference) {
    const target = definitions[reference];
    if (target === undefined || activeReferences.has(reference)) return;
    const nextReferences = new Set(activeReferences);
    nextReferences.add(reference);
    visitSchema(target, path, paths, definitions, nextReferences);
    return;
  }

  if (isRecord(schema.properties)) {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === 'string')
        : [],
    );
    for (const [name, child] of Object.entries(schema.properties)) {
      const childPath = [...path, name];
      if (!required.has(name)) paths.push(childPath);
      visitSchema(child, childPath, paths, definitions, activeReferences);
    }
  }
  if (schema.items !== undefined) {
    visitSchema(schema.items, [...path, ARRAY_ITEM], paths, definitions, activeReferences);
  }
  if (Array.isArray(schema.prefixItems)) {
    schema.prefixItems.forEach((child, index) => {
      visitSchema(child, [...path, index], paths, definitions, activeReferences);
    });
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      visitSchema(variant, path, paths, definitions, activeReferences);
    }
  }
}

function definitionsOf(schema: TSchema): Readonly<Record<string, unknown>> {
  const record: unknown = schema;
  if (!isRecord(record)) return {};
  if (isRecord(record.$defs)) return record.$defs;
  if (isRecord(record.definitions)) return record.definitions;
  return {};
}

function localDefinitionName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('#/$defs/')) return value.slice('#/$defs/'.length);
  if (value.startsWith('#/definitions/')) return value.slice('#/definitions/'.length);
  return undefined;
}

function removeIntroducedNull(value: unknown, path: readonly PathSegment[], index: number): void {
  if (index >= path.length) return;
  const segment = path[index];
  if (segment === undefined) return;
  if (segment === ARRAY_ITEM) {
    if (!Array.isArray(value)) return;
    for (const item of value) removeIntroducedNull(item, path, index + 1);
    return;
  }
  if (typeof segment === 'number') {
    if (!Array.isArray(value) || segment >= value.length) return;
    removeIntroducedNull(value[segment], path, index + 1);
    return;
  }
  if (!isRecord(value) || !Object.hasOwn(value, segment)) return;
  if (index === path.length - 1) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (value[segment] === null) delete value[segment];
    return;
  }
  removeIntroducedNull(value[segment], path, index + 1);
}

function addIntroducedNull(value: unknown, path: readonly PathSegment[], index: number): void {
  if (index >= path.length) return;
  const segment = path[index];
  if (segment === undefined) return;
  if (segment === ARRAY_ITEM) {
    if (!Array.isArray(value)) return;
    for (const item of value) addIntroducedNull(item, path, index + 1);
    return;
  }
  if (typeof segment === 'number') {
    if (!Array.isArray(value) || segment >= value.length) return;
    addIntroducedNull(value[segment], path, index + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (index === path.length - 1) {
    if (!Object.hasOwn(value, segment)) value[segment] = null;
    return;
  }
  if (!Object.hasOwn(value, segment)) return;
  addIntroducedNull(value[segment], path, index + 1);
}

function assertSchema(schema: TSchema, value: unknown, label: 'wire' | 'host'): void {
  const validation = validateSchemaResult(schema, value, 'strict');
  if (validation.valid) return;
  const detail = validation.failures.map(({ path, message }) => `${path}: ${message}`).join('; ');
  throw new TypeError(`Provider tool ${label} schema rejected arguments: ${detail}`);
}

function assertObject(
  value: unknown,
  message: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

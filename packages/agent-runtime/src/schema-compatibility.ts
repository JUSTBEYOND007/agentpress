import type { TSchema } from 'typebox';

import { applyProviderSchemaPolicy } from './provider-schema-policy.js';

export {
  validateSchemaResult,
  type JsonSchemaContract,
  type SchemaValidationFailure,
  type SchemaValidationMode,
  type SchemaValidationResult,
} from '@agentpress/schema-runtime';

export type SchemaProvider = 'openai' | 'anthropic' | 'google' | 'ollama' | 'mcp' | 'generic';
export type SchemaAdaptation = {
  readonly schema: TSchema;
  readonly provider: SchemaProvider;
  readonly strict: boolean;
  readonly degradations: readonly SchemaDegradation[];
};

export type SchemaDegradation = {
  readonly code:
    | 'removed_metadata'
    | 'dereferenced'
    | 'normalized_nullable'
    | 'normalized_union'
    | 'removed_unsupported_keyword';
  readonly path: string;
  readonly detail: string;
};

/**
 * Normalizes a TypeBox schema at the provider boundary. The input remains the
 * authoritative contract; this function only returns a wire copy and an
 * auditable list of transformations.
 */
export function adaptProviderSchema(
  schema: TSchema,
  options: {
    readonly provider?: SchemaProvider;
    readonly strict?: boolean;
  } = {},
): SchemaAdaptation {
  const degradations: SchemaDegradation[] = [];
  const provider = options.provider ?? 'generic';
  const strict = options.strict ?? false;
  const root = cloneJson(schema) as TSchema;
  const defs = isRecord(root) && isRecord(root.$defs) ? root.$defs : undefined;
  const preserveDefinitions = defs !== undefined && hasRecursiveDefinitions(defs);
  const normalized = normalizeNode(
    root,
    '$',
    defs,
    degradations,
    provider,
    strict,
    new Set(),
    preserveDefinitions,
  ) as TSchema;
  if (preserveDefinitions && isRecord(normalized)) {
    normalized.$defs = normalizeNode(
      defs,
      '$/$defs',
      defs,
      degradations,
      provider,
      strict,
      new Set(),
      preserveDefinitions,
    );
  }
  return { schema: normalized, provider, strict, degradations };
}

function normalizeNode(
  value: unknown,
  path: string,
  defs: Readonly<Record<string, unknown>> | undefined,
  degradations: SchemaDegradation[],
  provider: SchemaProvider,
  strict: boolean,
  refStack: ReadonlySet<string>,
  preserveDefinitions: boolean,
  nodeKind: 'schema' | 'schema-map' | 'schema-array' | 'data' = 'schema',
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      normalizeNode(
        item,
        `${path}/${String(index)}`,
        defs,
        degradations,
        provider,
        strict,
        refStack,
        preserveDefinitions,
        nodeKind === 'schema-array' ? 'schema' : 'data',
      ),
    );
  }
  if (nodeKind === 'schema' && provider === 'ollama' && typeof value === 'boolean') {
    degradations.push({
      code: 'normalized_union',
      path,
      detail: `boolean schema ${String(value)}`,
    });
    return value ? openJsonSchema() : { not: openJsonSchema() };
  }
  if (!isRecord(value)) return value;
  if (nodeKind === 'data') return value;
  if (nodeKind === 'schema-map') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeNode(
          child,
          `${path}/${escapePointer(key)}`,
          defs,
          degradations,
          provider,
          strict,
          refStack,
          preserveDefinitions,
          'schema',
        ),
      ]),
    );
  }

  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/$defs/') && defs) {
    const key = value.$ref.slice('#/$defs/'.length);
    const target = defs[key];
    if (target !== undefined && !refStack.has(key)) {
      degradations.push({ code: 'dereferenced', path, detail: value.$ref });
      const nextRefs = new Set(refStack);
      nextRefs.add(key);
      return normalizeNode(
        target,
        path,
        defs,
        degradations,
        provider,
        strict,
        nextRefs,
        preserveDefinitions,
      );
    }
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema' || key === '$id' || (key === '$defs' && !preserveDefinitions)) {
      degradations.push({ code: 'removed_metadata', path, detail: key });
      continue;
    }
    if (key === 'default' && (provider === 'openai' || provider === 'google') && strict) {
      degradations.push({ code: 'removed_unsupported_keyword', path, detail: key });
      continue;
    }
    if (
      provider === 'ollama' &&
      (key === 'additionalProperties' || key === 'unevaluatedProperties')
    ) {
      degradations.push({ code: 'removed_unsupported_keyword', path, detail: `ollama:${key}` });
      continue;
    }
    output[key] = normalizeNode(
      child,
      `${path}/${escapePointer(key)}`,
      defs,
      degradations,
      provider,
      strict,
      refStack,
      preserveDefinitions,
      schemaChildKind(key, child),
    );
  }

  const filtered = Object.fromEntries(
    Object.entries(output).filter(([, child]) => child !== undefined),
  );
  return applyProviderSchemaPolicy(filtered, path, provider, strict, degradations);
}

function schemaChildKind(
  key: string,
  value: unknown,
): 'schema' | 'schema-map' | 'schema-array' | 'data' {
  if (
    key === 'properties' ||
    key === 'patternProperties' ||
    key === 'dependentSchemas' ||
    key === '$defs' ||
    key === 'definitions'
  ) {
    return 'schema-map';
  }
  if (key === 'allOf' || key === 'anyOf' || key === 'oneOf' || key === 'prefixItems') {
    return 'schema-array';
  }
  if (
    key === 'items' ||
    key === 'additionalItems' ||
    key === 'contains' ||
    key === 'contentSchema' ||
    key === 'propertyNames' ||
    key === 'additionalProperties' ||
    key === 'unevaluatedItems' ||
    key === 'unevaluatedProperties' ||
    key === 'not' ||
    key === 'if' ||
    key === 'then' ||
    key === 'else'
  ) {
    return Array.isArray(value) ? 'schema-array' : 'schema';
  }
  return 'data';
}

function openJsonSchema(): Record<string, unknown> {
  return {
    anyOf: ['string', 'number', 'boolean', 'object', 'array', 'null'].map((type) => ({ type })),
  };
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasRecursiveDefinitions(defs: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(defs).some(([key, value]) => containsDefinitionRef(value, key));
}

function containsDefinitionRef(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsDefinitionRef(item, key));
  if (!isRecord(value)) return false;
  if (value.$ref === `#/$defs/${key}`) return true;
  return Object.values(value).some((child) => containsDefinitionRef(child, key));
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

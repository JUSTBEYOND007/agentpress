import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';

export type SchemaProvider = 'openai' | 'anthropic' | 'google' | 'ollama' | 'mcp' | 'generic';
export type SchemaValidationMode = 'strict' | 'permissive';

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

/** Validates a decoded tool/result payload without coercing or silently repairing it. */
export function validateSchemaResult(
  schema: TSchema,
  value: unknown,
  mode: SchemaValidationMode = 'strict',
): SchemaValidationResult {
  if (Value.Check(schema, value)) return { valid: true, value };
  const failures = [...Value.Errors(schema, value)].slice(0, 16).map((error) => ({
    path: 'path' in error && typeof error.path === 'string' ? error.path : '/',
    message: error.message,
  }));
  if (mode === 'permissive') return { valid: true, value, degraded: true, failures };
  return { valid: false, failures, mode };
}

export function providerFromId(provider: string): SchemaProvider {
  const normalized = provider.toLocaleLowerCase();
  if (normalized.includes('anthropic') || normalized.includes('claude')) return 'anthropic';
  if (normalized.includes('google') || normalized.includes('gemini')) return 'google';
  if (normalized.includes('ollama')) return 'ollama';
  if (normalized.includes('mcp')) return 'mcp';
  if (normalized.includes('openai') || normalized.includes('azure')) return 'openai';
  return 'generic';
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
      ),
    );
  }
  if (!isRecord(value)) return value;

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
    output[key] = normalizeNode(
      child,
      `${path}/${escapePointer(key)}`,
      defs,
      degradations,
      provider,
      strict,
      refStack,
      preserveDefinitions,
    );
  }

  if (Array.isArray(output.type) && output.type.includes('null')) {
    const nonNull = output.type.filter((type): type is string => type !== 'null');
    if (nonNull.length === 1) {
      output.type = nonNull[0];
      output.nullable = true;
      degradations.push({ code: 'normalized_nullable', path, detail: 'type union with null' });
    }
  }
  if (provider === 'google' && Array.isArray(output.anyOf) && output.anyOf.length === 1) {
    output.anyOf = undefined;
    degradations.push({ code: 'normalized_union', path, detail: 'single-branch anyOf' });
  }
  return Object.fromEntries(Object.entries(output).filter(([, child]) => child !== undefined));
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

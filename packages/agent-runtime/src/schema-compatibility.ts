import type { TSchema } from 'typebox';

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
  return applyProviderPolicy(filtered, path, provider, strict, degradations);
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

function applyProviderPolicy(
  schema: Record<string, unknown>,
  path: string,
  provider: SchemaProvider,
  strict: boolean,
  degradations: SchemaDegradation[],
): Record<string, unknown> {
  if (provider === 'openai' && strict) return normalizeOpenAiStrict(schema, path, degradations);
  if (provider === 'anthropic') return normalizeAnthropic(schema, path, degradations);
  if (provider === 'google') return normalizeGoogle(schema, path, degradations);
  if (provider === 'ollama') return normalizeOllama(schema, path, degradations);
  if (provider === 'mcp') return normalizeMcp(schema, path, degradations);
  return schema;
}

const OPENAI_STRICT_UNSUPPORTED = new Set([
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'propertyNames',
  'patternProperties',
  'unevaluatedProperties',
]);

function normalizeOpenAiStrict(
  source: Record<string, unknown>,
  path: string,
  degradations: SchemaDegradation[],
): Record<string, unknown> {
  const schema = { ...source };
  removeKeys(schema, OPENAI_STRICT_UNSUPPORTED, path, degradations);
  convertConstToEnum(schema, path, degradations);
  if (Array.isArray(schema.type)) {
    const variants = uniqueStrings(schema.type).map((type) => ({ type }));
    delete schema.type;
    schema.anyOf = mergeUnion(schema.anyOf, variants);
    degradations.push({ code: 'normalized_union', path, detail: 'OpenAI strict type array' });
  }
  if (isObjectSchema(schema)) {
    const properties = isRecord(schema.properties) ? { ...schema.properties } : {};
    const originallyRequired = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === 'string')
        : [],
    );
    for (const [key, child] of Object.entries(properties)) {
      if (!originallyRequired.has(key)) {
        properties[key] = makeNullableSchema(child);
        degradations.push({
          code: 'normalized_nullable',
          path: `${path}/properties/${escapePointer(key)}`,
          detail: 'OpenAI strict optional property',
        });
      }
    }
    schema.properties = properties;
    schema.required = Object.keys(properties);
    schema.additionalProperties = false;
  }
  return schema;
}

function normalizeAnthropic(
  source: Record<string, unknown>,
  path: string,
  degradations: SchemaDegradation[],
): Record<string, unknown> {
  const schema = { ...source };
  const scalar = principalType(schema);
  const spillKeys = new Set<string>();
  if (scalar === 'number' || scalar === 'integer') {
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])
      spillKeys.add(key);
  }
  if (scalar === 'string') {
    for (const key of ['pattern', 'minLength', 'maxLength']) spillKeys.add(key);
    if (
      typeof schema.format === 'string' &&
      !new Set([
        'date-time',
        'date',
        'time',
        'email',
        'hostname',
        'ipv4',
        'ipv6',
        'uri',
        'uuid',
      ]).has(schema.format)
    ) {
      spillKeys.add('format');
    }
  }
  if (scalar === 'array') {
    spillKeys.add('maxItems');
    spillKeys.add('uniqueItems');
    if (schema.minItems !== 0 && schema.minItems !== 1) spillKeys.add('minItems');
  }
  if (scalar === 'object') {
    spillKeys.add('patternProperties');
    spillKeys.add('propertyNames');
    spillKeys.add('minProperties');
    spillKeys.add('maxProperties');
    if (schema.additionalProperties === undefined) schema.additionalProperties = false;
  }
  spillKeys.add('oneOf');
  if (path === '$') {
    spillKeys.add('anyOf');
    spillKeys.add('allOf');
  }
  const spilled: Record<string, unknown> = {};
  for (const key of spillKeys) {
    if (!Object.hasOwn(schema, key)) continue;
    spilled[key] = schema[key];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete schema[key];
    degradations.push({ code: 'removed_unsupported_keyword', path, detail: `anthropic:${key}` });
  }
  if (Object.keys(spilled).length > 0) {
    const suffix = JSON.stringify(spilled);
    schema.description =
      typeof schema.description === 'string' && schema.description
        ? `${schema.description}\n\n${suffix}`
        : suffix;
  }
  return schema;
}

function normalizeGoogle(
  source: Record<string, unknown>,
  path: string,
  degradations: SchemaDegradation[],
): Record<string, unknown> {
  const schema = { ...source };
  removeKeys(
    schema,
    new Set([
      'additionalProperties',
      'unevaluatedProperties',
      'patternProperties',
      'propertyNames',
      'minProperties',
      'maxProperties',
      '$schema',
      '$id',
    ]),
    path,
    degradations,
  );
  convertConstToEnum(schema, path, degradations);
  if (Array.isArray(schema.type)) {
    const types = uniqueStrings(schema.type);
    const nonNull = types.filter((type) => type !== 'null');
    if (nonNull.length === 1 && types.includes('null')) {
      schema.type = nonNull[0];
      schema.nullable = true;
      degradations.push({ code: 'normalized_nullable', path, detail: 'Google type array' });
    }
  }
  if (schema.type === 'null') {
    delete schema.type;
    schema.nullable = true;
    degradations.push({ code: 'normalized_nullable', path, detail: 'Google null schema' });
  }
  if (Array.isArray(schema.anyOf)) {
    const nonNull = schema.anyOf.filter(
      (variant) => !(isRecord(variant) && variant.type === 'null'),
    );
    if (nonNull.length === 1 && nonNull.length !== schema.anyOf.length && isRecord(nonNull[0])) {
      delete schema.anyOf;
      Object.assign(schema, nonNull[0], { nullable: true });
      degradations.push({ code: 'normalized_nullable', path, detail: 'Google nullable anyOf' });
    }
  }
  inferEnumType(schema);
  if (isObjectSchema(schema) && !isRecord(schema.properties)) schema.properties = {};
  return schema;
}

function normalizeOllama(
  source: Record<string, unknown>,
  path: string,
  degradations: SchemaDegradation[],
): Record<string, unknown> {
  const schema = { ...source };
  for (const key of ['additionalProperties', 'unevaluatedProperties']) {
    if (typeof schema[key] !== 'boolean') continue;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete schema[key];
    degradations.push({ code: 'removed_unsupported_keyword', path, detail: `ollama:${key}` });
  }
  if (Array.isArray(schema.type)) {
    const variants = uniqueStrings(schema.type);
    const nonNull = variants.filter((type) => type !== 'null');
    if (nonNull.length <= 1) {
      schema.type = nonNull[0] ?? variants[0];
    } else {
      delete schema.type;
      const union = { anyOf: variants.map((type) => ({ type })) };
      schema.allOf = Array.isArray(schema.allOf)
        ? [union, ...(schema.allOf as readonly unknown[])]
        : [union];
    }
    degradations.push({ code: 'normalized_union', path, detail: 'Ollama type array' });
  }
  return schema;
}

function normalizeMcp(
  source: Record<string, unknown>,
  path: string,
  degradations: SchemaDegradation[],
): Record<string, unknown> {
  if (isRecord(source.def) && source.def.type === source.type) {
    if (source.type === 'enum') {
      const entries = isRecord(source.def.entries) ? Object.values(source.def.entries) : [];
      const values = entries.filter(isJsonPrimitive);
      const type = commonPrimitiveType(values);
      if (type) {
        degradations.push({ code: 'removed_unsupported_keyword', path, detail: 'MCP Zod enum' });
        return { type, enum: values };
      }
    }
    if (source.type === 'literal' && Array.isArray(source.def.values)) {
      const values = source.def.values.filter(isJsonPrimitive);
      const type = commonPrimitiveType(values);
      if (type && values.length > 0) {
        degradations.push({ code: 'removed_unsupported_keyword', path, detail: 'MCP Zod literal' });
        return { type, enum: values };
      }
    }
  }
  const schema = { ...source };
  if (Object.hasOwn(schema, 'nullable')) {
    delete schema.nullable;
    degradations.push({ code: 'removed_unsupported_keyword', path, detail: 'mcp:nullable' });
  }
  for (const [key, value] of Object.entries(schema)) {
    if (value !== null) continue;
    if (
      key === 'format' ||
      key === 'minLength' ||
      key === 'maxLength' ||
      key === 'minimum' ||
      key === 'maximum'
    ) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete schema[key];
      degradations.push({ code: 'removed_unsupported_keyword', path, detail: `mcp:${key}` });
    }
  }
  return schema;
}

function removeKeys(
  schema: Record<string, unknown>,
  keys: ReadonlySet<string>,
  path: string,
  degradations: SchemaDegradation[],
): void {
  for (const key of keys) {
    if (!Object.hasOwn(schema, key)) continue;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete schema[key];
    degradations.push({ code: 'removed_unsupported_keyword', path, detail: key });
  }
}

function convertConstToEnum(
  schema: Record<string, unknown>,
  path: string,
  degradations: SchemaDegradation[],
): void {
  if (!Object.hasOwn(schema, 'const') || !isJsonPrimitive(schema.const)) return;
  schema.enum = [schema.const];
  delete schema.const;
  inferEnumType(schema);
  degradations.push({ code: 'normalized_union', path, detail: 'const to enum' });
}

function inferEnumType(schema: Record<string, unknown>): void {
  if (schema.type !== undefined || !Array.isArray(schema.enum)) return;
  const type = commonPrimitiveType(schema.enum.filter(isJsonPrimitive));
  if (type) schema.type = type;
}

function makeNullableSchema(value: unknown): unknown {
  if (isRecord(value) && Array.isArray(value.anyOf)) {
    if (value.anyOf.some((variant) => isRecord(variant) && variant.type === 'null')) return value;
    return { ...value, anyOf: [...(value.anyOf as readonly unknown[]), { type: 'null' }] };
  }
  if (isRecord(value) && Array.isArray(value.type) && value.type.includes('null')) return value;
  return { anyOf: [value, { type: 'null' }] };
}

function mergeUnion(existing: unknown, variants: readonly unknown[]): readonly unknown[] {
  return Array.isArray(existing) ? [...(existing as readonly unknown[]), ...variants] : variants;
}

function principalType(schema: Record<string, unknown>): string | undefined {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    return schema.type.find((type): type is string => typeof type === 'string' && type !== 'null');
  }
  if (isRecord(schema.properties)) return 'object';
  if (schema.items !== undefined) return 'array';
  return undefined;
}

function isObjectSchema(schema: Record<string, unknown>): boolean {
  return schema.type === 'object' || isRecord(schema.properties);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function commonPrimitiveType(
  values: readonly (string | number | boolean | null)[],
): string | undefined {
  if (values.length === 0) return undefined;
  const types = new Set(
    values.map((value) =>
      value === null
        ? 'null'
        : typeof value === 'number' && Number.isInteger(value)
          ? 'integer'
          : typeof value,
    ),
  );
  return types.size === 1 ? [...types][0] : undefined;
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

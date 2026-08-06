import type { SchemaDegradation, SchemaProvider } from './schema-compatibility.js';

export function applyProviderSchemaPolicy(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

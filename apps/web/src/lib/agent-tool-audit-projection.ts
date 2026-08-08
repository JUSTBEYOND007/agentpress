import type { RunPart, ToolActivityAudit } from './agent-runtime-contracts';

export function toolActivityAudit(part: RunPart): ToolActivityAudit | undefined {
  if (part.type !== 'activity' || !part.status.startsWith('tool.')) return undefined;
  const existing = recordProperty(part.payload, 'toolAudit');
  const transport = Object.keys(existing).length
    ? existing
    : recordProperty(part.payload, 'transportProvenance');
  if (transport.kind !== 'mcp') return undefined;
  const serverId = boundedString(transport, 'serverId');
  const serverRevision = boundedString(transport, 'serverRevision');
  const toolName = boundedString(transport, 'toolName');
  const toolRevision = boundedString(transport, 'toolRevision');
  const adapterRevision = boundedString(transport, 'adapterRevision');
  if (!serverId || !serverRevision || !toolName || !toolRevision || !adapterRevision) {
    return undefined;
  }
  const argumentSummary = boundedArgumentSummary(
    Object.keys(existing).length ? existing.argumentSummary : part.payload.argumentSummary,
  );
  const argumentKeys = Object.keys(existing).length
    ? []
    : Object.keys(recordProperty(part.payload, 'arguments'));
  const rawArguments = argumentKeys
    .filter((value) => value.length > 0 && value.length <= 160 && value === value.trim())
    .sort();
  const existingNames = Array.isArray(existing.argumentNames)
    ? existing.argumentNames.filter(
        (value): value is string =>
          typeof value === 'string' &&
          value.length > 0 &&
          value.length <= 160 &&
          value === value.trim(),
      )
    : [];
  const summaryNames = argumentSummary?.fields.map(({ name }) => name) ?? [];
  const argumentNames = (
    summaryNames.length ? summaryNames : existingNames.length ? existingNames : rawArguments
  ).slice(0, 12);
  const rawArgumentCount = existing.argumentCount;
  const argumentCount = Math.min(
    10_000,
    typeof rawArgumentCount === 'number' && Number.isSafeInteger(rawArgumentCount)
      ? Math.max(argumentNames.length, rawArgumentCount)
      : (argumentSummary?.fieldCount ?? argumentKeys.length),
  );
  const taskAttempt = positiveInteger(existing.taskAttempt ?? part.payload.taskAttempt);
  const durationMs = boundedDuration(existing.durationMs ?? part.payload.durationMs);
  const outputReference = outputArtifactReference(
    Object.keys(existing).length ? existing.outputReference : part.payload.output,
  );
  return {
    kind: 'mcp',
    serverId,
    serverRevision,
    toolName,
    toolRevision,
    adapterRevision,
    ...(taskAttempt ? { taskAttempt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    argumentNames,
    argumentCount,
    ...(argumentSummary ? { argumentSummary } : {}),
    ...(outputReference ? { outputReference } : {}),
  };
}

function boundedArgumentSummary(value: unknown): ToolActivityAudit['argumentSummary'] | undefined {
  const summary = asRecord(value);
  if (summary.schemaVersion !== 1) return undefined;
  const fieldCount = boundedInteger(summary.fieldCount, 10_000);
  const additionalFieldCount = boundedInteger(summary.additionalFieldCount, 10_000);
  if (
    fieldCount === undefined ||
    additionalFieldCount === undefined ||
    additionalFieldCount > fieldCount
  ) {
    return undefined;
  }
  if (!Array.isArray(summary.fields) || summary.fields.length > 32) return undefined;
  const fields = summary.fields.map(boundedArgumentField);
  if (fields.some((field) => field === undefined)) return undefined;
  return {
    schemaVersion: 1,
    fieldCount,
    additionalFieldCount,
    fields: fields as NonNullable<ToolActivityAudit['argumentSummary']>['fields'],
  };
}

function boundedArgumentField(
  value: unknown,
): NonNullable<ToolActivityAudit['argumentSummary']>['fields'][number] | undefined {
  const field = asRecord(value);
  const name = boundedString(field, 'name');
  const schemaTypes = Array.isArray(field.schemaTypes)
    ? field.schemaTypes.filter(isArgumentType).slice(0, 8)
    : [];
  if (
    !name ||
    typeof field.required !== 'boolean' ||
    !isArgumentType(field.valueType) ||
    schemaTypes.length === 0
  ) {
    return undefined;
  }
  const stringLength = boundedInteger(field.stringLength, 1_000_000);
  const arrayLength = boundedInteger(field.arrayLength, 1_000_000);
  const objectKeyCount = boundedInteger(field.objectKeyCount, 1_000_000);
  return {
    name,
    required: field.required,
    schemaTypes,
    valueType: field.valueType,
    ...(stringLength !== undefined ? { stringLength } : {}),
    ...(arrayLength !== undefined ? { arrayLength } : {}),
    ...(objectKeyCount !== undefined ? { objectKeyCount } : {}),
  };
}

function isArgumentType(value: unknown): value is string {
  return ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null', 'unknown'].includes(
    String(value),
  );
}

function boundedInteger(value: unknown, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function boundedDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000
    ? Math.round(value)
    : undefined;
}

function outputArtifactReference(value: unknown): ToolActivityAudit['outputReference'] | undefined {
  const output =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  const artifact = recordProperty(output, 'artifact');
  const guardedValue = recordProperty(output, 'value');
  const source = boundedString(output, 'artifactId')
    ? output
    : Object.keys(artifact).length
      ? artifact
      : guardedValue;
  const artifactId = boundedString(source, 'artifactId');
  if (!artifactId) return undefined;
  const versionId = boundedString(source, 'versionId');
  const uri = boundedString(source, 'uri');
  return {
    artifactId,
    ...(versionId ? { versionId } : {}),
    ...(uri?.startsWith('artifact://') ? { uri } : {}),
  };
}

function recordProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const candidate = value[key];
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Readonly<Record<string, unknown>>)
    : {};
}

function boundedString(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= 240 &&
    candidate === candidate.trim()
    ? candidate
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

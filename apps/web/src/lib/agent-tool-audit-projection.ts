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
  const argumentNames = (existingNames.length ? existingNames : rawArguments).slice(0, 12);
  const rawArgumentCount = existing.argumentCount;
  const argumentCount = Math.min(
    10_000,
    typeof rawArgumentCount === 'number' && Number.isSafeInteger(rawArgumentCount)
      ? Math.max(argumentNames.length, rawArgumentCount)
      : argumentKeys.length,
  );
  const taskAttempt = positiveInteger(existing.taskAttempt ?? part.payload.taskAttempt);
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
    argumentNames,
    argumentCount,
    ...(outputReference ? { outputReference } : {}),
  };
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

import type { RunPart } from './agent-runtime-contracts';

export function sanitizeActivityPayload(part: RunPart): Readonly<Record<string, unknown>> {
  return compact({
    toolId: boundedString(part.payload.toolId),
    toolCallId: boundedString(part.payload.toolCallId),
    taskId: boundedString(part.payload.taskId),
    taskAttempt: positiveInteger(part.payload.taskAttempt),
    owner: boundedString(part.payload.owner),
    summary: boundedString(part.payload.summary, 1_000),
    eventAt: timestamp(part.payload.eventAt),
    lifecycleStartedAt: timestamp(part.payload.lifecycleStartedAt),
    durationMs: boundedNumber(part.payload.durationMs, 86_400_000),
    progress: boundedProgress(part.payload.progress),
    lifecycleStages: boundedLifecycleStages(part.payload.lifecycleStages),
    output: boundedBusinessOutput(part.payload.output),
  });
}

export function sanitizeApprovalPayload(part: RunPart): Readonly<Record<string, unknown>> {
  return compact({
    toolCallId: boundedString(part.payload.toolCallId),
    approvalId: boundedString(part.payload.approvalId),
    toolId: boundedString(part.payload.toolId),
    toolVersion: boundedString(part.payload.toolVersion),
    risk: boundedString(part.payload.risk),
    sideEffect: boundedString(part.payload.sideEffect, 1_000),
  });
}

function boundedLifecycleStages(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((candidate) => {
    const stage = record(candidate);
    const status = boundedString(stage.status);
    if (!status) return [];
    return [
      compact({
        stageId: boundedString(stage.stageId),
        labelKey: boundedString(stage.labelKey),
        status,
        outcome: boundedString(stage.outcome),
        startedAt: timestamp(stage.startedAt),
        completedAt: timestamp(stage.completedAt),
        eventAt: timestamp(stage.eventAt),
        progress: boundedProgress(stage.progress),
      }),
    ];
  });
}

function boundedBusinessOutput(value: unknown): Readonly<Record<string, unknown>> {
  const output = record(value);
  return compact({
    summary: boundedString(output.summary, 1_000),
    proposalId: boundedString(output.proposalId),
    artifactId: boundedString(output.artifactId),
    versionId: boundedString(output.versionId),
    uri: artifactUri(output.uri),
    sourceCount: boundedNumber(output.sourceCount, 10_000),
    partialFailureCount: boundedNumber(output.partialFailureCount, 10_000),
    confidence: boundedNumber(output.confidence, 1),
  });
}

function boundedProgress(value: unknown): Readonly<Record<string, number>> | undefined {
  const progress = record(value);
  const completed = boundedNumber(progress.completed, 1_000_000);
  const total = boundedNumber(progress.total, 1_000_000);
  if (completed === undefined || total === undefined || completed > total) return undefined;
  return { completed, total };
}

function boundedString(value: unknown, maximum = 240): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function artifactUri(value: unknown): string | undefined {
  const uri = boundedString(value);
  return uri?.startsWith('artifact://') ? uri : undefined;
}

function timestamp(value: unknown): string | undefined {
  const candidate = boundedString(value);
  if (!candidate) return undefined;
  return Number.isNaN(new Date(candidate).getTime()) ? undefined : candidate;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function boundedNumber(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function compact(
  value: Readonly<Record<string, unknown | undefined>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

export type EvalTraceEvent = {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
};

export type ProcessMetrics = {
  readonly routeCount: number;
  readonly delegationCount: number;
  readonly toolCallCount: number;
  readonly approvalCount: number;
  readonly retryCount: number;
  readonly recoveryCount: number;
  readonly repeatedSideEffectCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs?: number;
};

export type ResultMetrics = {
  readonly succeeded: boolean;
  readonly schemaValid: boolean;
  readonly citationPrecision: number;
  readonly artifactQuality?: number;
  readonly minimalEdit?: boolean;
  readonly unknownAnswerCorrect?: boolean;
};

export function scoreProcessTrace(events: readonly EvalTraceEvent[]): ProcessMetrics {
  const count = (types: ReadonlySet<string>) => events.filter(({ type }) => types.has(type)).length;
  const usage = events
    .filter(({ type }) => type === 'usage.updated')
    .reduce(
      (total, event) => ({
        inputTokens: total.inputTokens + numberValue(event.payload?.inputTokens),
        outputTokens: total.outputTokens + numberValue(event.payload?.outputTokens),
        costUsd: total.costUsd + numberValue(event.payload?.costUsd),
      }),
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
  const latencyMs = durationValue(events);
  return {
    routeCount: count(new Set(['run.started', 'run.route'])),
    delegationCount: count(new Set(['task.created', 'specialist.started'])),
    toolCallCount: count(new Set(['tool.started'])),
    approvalCount: count(new Set(['approval.requested'])),
    retryCount: count(new Set(['run.retry', 'task.retry', 'tool.retry'])),
    recoveryCount: count(new Set(['run.recovered', 'task.recovered'])),
    repeatedSideEffectCount: count(new Set(['tool.duplicate_side_effect'])),
    ...usage,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
}

export function redactTrace(events: readonly EvalTraceEvent[]): readonly EvalTraceEvent[] {
  return events.map((event) => ({
    type: event.type,
    ...(event.payload ? { payload: redactRecord(event.payload) } : {}),
  }));
}

function redactRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /(authorization|api[_-]?key|token|password|secret)/iu.test(key)
        ? '[REDACTED]'
        : item && typeof item === 'object' && !Array.isArray(item)
          ? redactRecord(item as Readonly<Record<string, unknown>>)
          : item,
    ]),
  );
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function durationValue(events: readonly EvalTraceEvent[]): number | undefined {
  const start = events.find(({ type }) => type === 'run.started')?.payload?.timestamp;
  const end = [...events].reverse().find(({ type }) => type === 'run.completed')?.payload?.timestamp;
  return typeof start === 'number' && typeof end === 'number' && end >= start ? end - start : undefined;
}

import type { RuntimeUsage } from '@agentpress/agent-runtime';

import type { DurableRunEvent, RunPart } from './contracts.js';

export type PersistedModelSelection = {
  readonly purpose: string;
  readonly selectedModel: string;
  readonly policySnapshot: Readonly<Record<string, unknown>>;
  readonly fallbackUsed: boolean;
};

export function projectRunExecutionFacts(input: {
  readonly runId: string;
  readonly events: readonly DurableRunEvent[];
  readonly modelSelections: readonly PersistedModelSelection[];
  readonly createdAt: Date;
  readonly completedAt?: Date;
}): RunPart | undefined {
  const usage = aggregateUsage(input.events);
  const executions = uniqueExecutions(input.modelSelections);
  const durationMs = input.completedAt
    ? Math.max(0, input.completedAt.getTime() - input.createdAt.getTime())
    : undefined;
  if (!usage && executions.length === 0 && durationMs === undefined) return undefined;
  return {
    id: `${input.runId}:execution-facts`,
    runId: input.runId,
    sequence: input.events.at(-1)?.sequence ?? 0,
    type: 'usage',
    status: 'execution.facts',
    payload: {
      ...(usage ? { usage } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      executions,
    },
  };
}

function aggregateUsage(events: readonly DurableRunEvent[]): RuntimeUsage | undefined {
  const messageUsages = events.flatMap((event) => {
    if (event.eventType !== 'message.completed') return [];
    const message = recordValue(event.payload.message);
    if (message.role !== 'assistant') return [];
    const usage = runtimeUsage(message.usage);
    return usage ? [usage] : [];
  });
  const usages =
    messageUsages.length > 0
      ? messageUsages
      : events.flatMap((event) => {
          if (!event.eventType.startsWith('run.completed')) return [];
          const usage = runtimeUsage(event.payload.usage);
          return usage ? [usage] : [];
        });
  if (usages.length === 0) return undefined;
  return usages.reduce<RuntimeUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
      costUsd: total.costUsd + usage.costUsd,
    }),
    emptyUsage,
  );
}

function uniqueExecutions(selections: readonly PersistedModelSelection[]) {
  const unique = new Map<string, Readonly<Record<string, unknown>>>();
  for (const selection of selections) {
    const provider = stringValue(selection.policySnapshot.provider) || 'unknown';
    const contextWindow = positiveNumber(selection.policySnapshot.contextWindow);
    const maxOutputTokens = positiveNumber(selection.policySnapshot.maxOutputTokens);
    const policyRevision = stringValue(selection.policySnapshot.policyRevision);
    const key = [
      selection.purpose,
      provider,
      selection.selectedModel,
      contextWindow,
      maxOutputTokens,
      policyRevision,
      selection.fallbackUsed,
    ].join(':');
    unique.set(key, {
      purpose: selection.purpose,
      provider,
      model: selection.selectedModel,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(policyRevision ? { policyRevision } : {}),
      fallbackUsed: selection.fallbackUsed,
    });
  }
  return [...unique.values()];
}

function runtimeUsage(value: unknown): RuntimeUsage | undefined {
  const usage = recordValue(value);
  const inputTokens = nonNegativeNumber(usage.inputTokens);
  const outputTokens = nonNegativeNumber(usage.outputTokens);
  const cacheReadTokens = nonNegativeNumber(usage.cacheReadTokens);
  const cacheWriteTokens = nonNegativeNumber(usage.cacheWriteTokens);
  const totalTokens = nonNegativeNumber(usage.totalTokens);
  const costUsd = nonNegativeNumber(usage.costUsd);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined ||
    totalTokens === undefined ||
    costUsd === undefined
  )
    return undefined;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, costUsd };
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const emptyUsage: RuntimeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

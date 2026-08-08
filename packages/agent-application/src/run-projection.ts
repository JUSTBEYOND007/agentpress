import type { ActivityOutcome, DurableRunEvent, RunPart } from './contracts.js';

export type ProposalProjectionStatus =
  | 'pending'
  | 'partially_accepted'
  | 'accepted'
  | 'rejected'
  | 'expired';

export function projectRunParts(
  events: readonly DurableRunEvent[],
  proposalStatuses: ReadonlyMap<string, ProposalProjectionStatus> = new Map(),
): readonly RunPart[] {
  const projected: RunPart[] = [];
  const lifecycleIndexes = new Map<string, number>();
  let activeReasoningIndex: number | undefined;

  for (const event of events) {
    if (activeReasoningIndex !== undefined && closesReasoning(event.eventType)) {
      const reasoning = projected[activeReasoningIndex];
      const startedAt = reasoning ? dateProperty(reasoning.payload, 'startedAt') : undefined;
      if (reasoning?.status === 'run.planning') {
        projected[activeReasoningIndex] = {
          ...reasoning,
          status: 'reasoning.completed',
          payload: {
            ...reasoning.payload,
            completedAt: event.createdAt.toISOString(),
            ...(startedAt
              ? { durationMs: Math.max(0, event.createdAt.getTime() - startedAt.getTime()) }
              : {}),
          },
        };
      }
      activeReasoningIndex = undefined;
    }
    for (const part of toRunParts(event, proposalStatuses)) {
      const key = lifecycleKey(event);
      if (!key) {
        projected.push(part);
        if (part.type === 'reasoning') activeReasoningIndex = projected.length - 1;
        continue;
      }
      const previousIndex = lifecycleIndexes.get(key);
      if (previousIndex === undefined) {
        lifecycleIndexes.set(key, projected.length);
        projected.push({
          ...part,
          payload: { ...part.payload, lifecycleStages: [lifecycleStage(part)] },
        });
      } else {
        const previous = projected[previousIndex];
        const startedAt = previous
          ? dateProperty(previous.payload, 'lifecycleStartedAt')
          : undefined;
        const eventAt = dateProperty(part.payload, 'eventAt');
        projected[previousIndex] = previous
          ? {
              ...part,
              payload: {
                ...previous.payload,
                ...part.payload,
                lifecycleStages: [...lifecycleStages(previous.payload), lifecycleStage(part)],
                ...(startedAt ? { lifecycleStartedAt: startedAt.toISOString() } : {}),
                ...(startedAt && eventAt && isSettledLifecycleStatus(part.status)
                  ? { durationMs: Math.max(0, eventAt.getTime() - startedAt.getTime()) }
                  : {}),
              },
            }
          : part;
      }
    }
  }

  return projected;
}

function lifecycleStage(part: RunPart): Readonly<Record<string, unknown>> {
  const eventAt = part.payload.eventAt;
  const settled = part.outcome !== undefined;
  const progress = recordProperty(part.payload, 'progress');
  return {
    stageId: `${part.id}:${String(part.sequence)}`,
    labelKey: stageLabelKey(part.status, part.outcome),
    status: part.status,
    ...(part.outcome ? { outcome: part.outcome } : {}),
    ...(settled ? { completedAt: eventAt } : { startedAt: eventAt }),
    ...(Object.keys(progress).length > 0 ? { progress } : {}),
    eventAt,
  };
}

function stageLabelKey(status: string, outcome?: ActivityOutcome): string {
  if (outcome === 'succeeded') return 'execution.succeeded';
  if (outcome === 'degraded') return 'execution.degraded';
  if (outcome === 'failed') return 'execution.failed';
  if (outcome === 'cancelled') return 'execution.cancelled';
  if (outcome === 'timed_out') return 'execution.timed_out';
  if (outcome === 'interrupted') return 'execution.interrupted';
  if (outcome === 'stale') return 'execution.stale';
  if (outcome === 'outcome_unknown') return 'execution.outcome_unknown';
  if (status.endsWith('.executing')) return 'execution.executing';
  return 'execution.started';
}

function lifecycleStages(
  payload: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(payload.lifecycleStages)
    ? payload.lifecycleStages.filter(
        (value): value is Readonly<Record<string, unknown>> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
      )
    : [];
}

function isSettledLifecycleStatus(status: string): boolean {
  return /\.(succeeded|failed|cancelled|denied|expired|outcome_unknown)$/u.test(status);
}

function closesReasoning(eventType: string): boolean {
  return (
    eventType === 'message.completed' ||
    eventType === 'article.proposal.created' ||
    eventType === 'user.input_requested' ||
    eventType.startsWith('plan.') ||
    eventType.startsWith('tool.') ||
    eventType.startsWith('task.') ||
    eventType.startsWith('action.') ||
    eventType.startsWith('run.completed') ||
    eventType === 'run.failed' ||
    eventType === 'run.cancelled'
  );
}

function lifecycleKey(event: DurableRunEvent): string | undefined {
  if (event.eventType.startsWith('tool.')) {
    const toolCallId = stringProperty(event.payload, 'toolCallId');
    return toolCallId ? `tool:${toolCallId}` : undefined;
  }
  if (event.eventType.startsWith('task.')) {
    const taskId = stringProperty(event.payload, 'taskId');
    const attempt = positiveIntegerProperty(event.payload, 'attempt');
    return taskId && attempt ? `task:${taskId}:attempt:${String(attempt)}` : undefined;
  }
  if (event.eventType.startsWith('action.')) {
    const proposalId =
      stringProperty(event.payload, 'id') ?? stringProperty(event.payload, 'proposalId');
    return proposalId ? `action:${proposalId}` : undefined;
  }
  return undefined;
}

function toRunParts(
  event: DurableRunEvent,
  proposalStatuses: ReadonlyMap<string, ProposalProjectionStatus>,
): readonly RunPart[] {
  const type = event.eventType;
  const partType =
    type === 'message.completed'
      ? 'text'
      : type === 'run.planning'
        ? 'reasoning'
        : type.startsWith('plan.')
          ? 'plan'
          : type.startsWith('action.')
            ? 'action-proposal'
            : type === 'article.proposal.created'
              ? 'article-change'
              : type === 'tool.approval_requested'
                ? 'tool-approval'
                : type === 'user.input_requested'
                  ? 'ask-user'
                  : type === 'tool.outcome_unknown'
                    ? 'warning'
                    : type.includes('artifact')
                      ? 'artifact'
                      : type.startsWith('run.recover')
                        ? 'recovery'
                        : type === 'run.completed_with_degradation' ||
                            type === 'run.failed' ||
                            type === 'run.cancelled'
                          ? 'warning'
                          : type.startsWith('tool.') || type.startsWith('task.')
                            ? 'activity'
                            : type.startsWith('run.completed')
                              ? 'usage'
                              : undefined;
  if (!partType) return [];

  const proposalId = proposalIdFromPayload(event.payload);
  const proposalStatus = proposalId ? proposalStatuses.get(proposalId) : undefined;
  const lifecycle = lifecycleKey(event);
  const outcome =
    partType === 'activity' || type === 'tool.outcome_unknown'
      ? activityOutcome(type, event.payload)
      : undefined;
  return [
    {
      id: lifecycle ? `${event.runId}:${lifecycle}` : event.id,
      runId: event.runId,
      sequence: event.sequence,
      type: partType,
      status: type,
      ...(outcome ? { outcome } : {}),
      ...(lifecycle ? { correlationId: lifecycle } : {}),
      payload: {
        ...event.payload,
        eventAt: event.createdAt.toISOString(),
        ...(lifecycle ? { lifecycleStartedAt: event.createdAt.toISOString() } : {}),
        ...(partType === 'reasoning' ? { startedAt: event.createdAt.toISOString() } : {}),
        ...(proposalStatus ? { proposalStatus } : {}),
      },
    },
  ];
}

function activityOutcome(
  status: string,
  payload: Readonly<Record<string, unknown>> = {},
): ActivityOutcome | undefined {
  if (status.endsWith('.succeeded') || status.endsWith('.completed')) return 'succeeded';
  if (status.endsWith('.degraded') || status === 'completed_with_degradation') return 'degraded';
  if (
    status.startsWith('task.') &&
    (payload.failure === 'task_timeout' || payload.failure === 'detached_task_timeout')
  )
    return 'timed_out';
  if (status.endsWith('.timed_out') || status.endsWith('.timeout') || status === 'task_timeout')
    return 'timed_out';
  if (status.endsWith('.cancelled') || status.endsWith('.canceled')) return 'cancelled';
  if (status.endsWith('.interrupted')) return 'interrupted';
  if (status.endsWith('.stale')) return 'stale';
  if (status.endsWith('.outcome_unknown')) return 'outcome_unknown';
  if (status.endsWith('.failed') || status.endsWith('.denied') || status.endsWith('.expired'))
    return 'failed';
  return undefined;
}

function dateProperty(value: Readonly<Record<string, unknown>>, key: string): Date | undefined {
  const candidate = value[key];
  if (typeof candidate !== 'string') return undefined;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function proposalIdFromPayload(payload: Readonly<Record<string, unknown>>): string | undefined {
  const output = recordProperty(payload, 'output');
  return stringProperty(output, 'proposalId') ?? stringProperty(payload, 'proposalId');
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

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function positiveIntegerProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const candidate = value[key];
  return Number.isSafeInteger(candidate) && Number(candidate) > 0 ? Number(candidate) : undefined;
}

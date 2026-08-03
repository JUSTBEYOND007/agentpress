import type { DurableRunEvent, RunPart } from './contracts.js';

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
      if (reasoning && reasoning.status === 'run.planning') {
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
        projected.push(part);
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

function isSettledLifecycleStatus(status: string): boolean {
  return /\.(succeeded|failed|cancelled|denied|expired)$/u.test(status);
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
    return taskId ? `task:${taskId}` : undefined;
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
  return [
    {
      id: lifecycle ? `${event.runId}:${lifecycle}` : event.id,
      runId: event.runId,
      sequence: event.sequence,
      type: partType,
      status: type,
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

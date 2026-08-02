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

  for (const event of events) {
    for (const part of toRunParts(event, proposalStatuses)) {
      const key = lifecycleKey(event);
      if (!key) {
        projected.push(part);
        continue;
      }
      const previousIndex = lifecycleIndexes.get(key);
      if (previousIndex === undefined) {
        lifecycleIndexes.set(key, projected.length);
        projected.push(part);
      } else {
        projected[previousIndex] = part;
      }
    }
  }

  return projected;
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
      : type.startsWith('plan.')
        ? 'plan'
        : type === 'tool.approval_requested'
          ? 'tool-approval'
          : type === 'user.input_requested'
            ? 'ask-user'
            : type.includes('artifact')
              ? 'artifact'
              : type.startsWith('run.recover')
                ? 'recovery'
                : type === 'run.completed_with_degradation' || type === 'run.failed'
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
      payload: proposalStatus ? { ...event.payload, proposalStatus } : event.payload,
    },
  ];
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

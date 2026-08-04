import type { DurableRunEvent, RunPart } from './contracts.js';

export type RunRecoveryPoint = {
  readonly sequence: number;
  readonly reason: string;
  readonly createdAt: Date;
};

export function projectRunProgress(input: {
  readonly runId: string;
  readonly mode: 'direct' | 'planned';
  readonly status: string;
  readonly events: readonly DurableRunEvent[];
  readonly pendingInteraction?: Readonly<Record<string, unknown>>;
  readonly recoveryPoint?: RunRecoveryPoint;
}): RunPart | undefined {
  if (input.mode !== 'planned' && !input.events.some(({ eventType }) => eventType.startsWith('task.')))
    return undefined;
  const tasks = latestPlanTasks(input.events);
  const taskStates = latestTaskStates(input.events);
  const completedSteps = [...taskStates.values()].filter(
    ({ eventType }) => eventType === 'task.succeeded',
  ).length;
  const activeTask = [...taskStates.values()].find(
    ({ eventType }) => eventType === 'task.started',
  );
  const totalSteps = Math.max(tasks.length, taskStates.size);
  return {
    id: `${input.runId}:progress`,
    runId: input.runId,
    sequence: input.events.at(-1)?.sequence ?? 0,
    type: 'progress',
    status: `progress.${input.status}`,
    payload: {
      phase: progressPhase(input.status, input.pendingInteraction),
      completedSteps,
      totalSteps,
      ...(activeTask
        ? {
            activeStep: {
              objective: stringValue(activeTask.payload.objective),
              owner: stringValue(activeTask.payload.owner),
            },
          }
        : {}),
      ...(input.pendingInteraction
        ? { outstandingInteraction: stringValue(input.pendingInteraction.type) }
        : {}),
      ...(input.recoveryPoint
        ? {
            recoveryPoint: {
              sequence: input.recoveryPoint.sequence,
              reason: input.recoveryPoint.reason,
              createdAt: input.recoveryPoint.createdAt.toISOString(),
            },
          }
        : {}),
    },
  };
}

function latestPlanTasks(events: readonly DurableRunEvent[]): readonly unknown[] {
  const event = [...events]
    .reverse()
    .find(({ eventType, payload }) => eventType.startsWith('plan.') && Array.isArray(payload.tasks));
  return event && Array.isArray(event.payload.tasks) ? event.payload.tasks : [];
}

function latestTaskStates(events: readonly DurableRunEvent[]) {
  const states = new Map<string, DurableRunEvent>();
  for (const event of events) {
    if (!event.eventType.startsWith('task.')) continue;
    const taskId = stringValue(event.payload.taskId);
    if (taskId) states.set(taskId, event);
  }
  return states;
}

function progressPhase(
  status: string,
  interaction: Readonly<Record<string, unknown>> | undefined,
): string {
  const interactionType = stringValue(interaction?.type);
  if (interactionType === 'ask-user') return 'waiting_for_user';
  if (interactionType === 'tool-approval') return 'waiting_for_approval';
  return status;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

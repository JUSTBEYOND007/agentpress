import { DomainError } from '../shared/domain-error.js';
import type { AgentRunId, AgentTaskId, PlanRevisionId } from '../shared/ids.js';
import { transitionState } from '../shared/transition.js';

export const AGENT_TASK_STATES = [
  'pending',
  'ready',
  'running',
  'waiting_for_approval',
  'interrupted',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;

export type AgentTaskStatus = (typeof AGENT_TASK_STATES)[number];
export type AgentTaskCriticality = 'required' | 'optional';
export type SpecialistRole = 'researcher' | 'writer' | 'editor' | 'fact_checker' | 'illustrator';

const TERMINAL_STATES: ReadonlySet<AgentTaskStatus> = new Set([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);

const TRANSITIONS: Readonly<Record<AgentTaskStatus, readonly AgentTaskStatus[]>> = {
  pending: ['ready', 'skipped', 'cancelled'],
  ready: ['running', 'skipped', 'cancelled'],
  running: ['succeeded', 'failed', 'waiting_for_approval', 'interrupted', 'cancelled'],
  waiting_for_approval: ['running', 'failed', 'cancelled'],
  interrupted: ['ready', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

export type AgentTask = {
  readonly id: AgentTaskId;
  readonly runId: AgentRunId;
  readonly planRevisionId: PlanRevisionId;
  readonly objective: string;
  readonly criticality: AgentTaskCriticality;
  readonly owner: 'main' | SpecialistRole;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyIds: readonly AgentTaskId[];
  readonly status: AgentTaskStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
  readonly version: number;
};

export type CreateAgentTask = {
  readonly now: Date;
} & Omit<AgentTask, 'status' | 'attempt' | 'createdAt' | 'updatedAt' | 'completedAt' | 'version'>;

export function createAgentTask(input: CreateAgentTask): AgentTask {
  return {
    id: input.id,
    runId: input.runId,
    planRevisionId: input.planRevisionId,
    objective: input.objective,
    criticality: input.criticality,
    owner: input.owner,
    acceptanceCriteria: input.acceptanceCriteria,
    dependencyIds: input.dependencyIds,
    status: 'pending',
    attempt: 0,
    maxAttempts: input.maxAttempts,
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
  };
}

export function transitionAgentTask(
  task: AgentTask,
  status: AgentTaskStatus,
  now: Date,
): AgentTask {
  const nextStatus = transitionState(
    'AgentTask',
    task.status,
    status,
    TRANSITIONS,
    TERMINAL_STATES,
  );
  const startsAttempt = task.status === 'ready' && nextStatus === 'running';

  if (startsAttempt && task.attempt >= task.maxAttempts) {
    throw new DomainError('invariant_violation', 'Agent Task attempt budget is exhausted', {
      taskId: task.id,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
    });
  }

  return {
    ...task,
    status: nextStatus,
    attempt: task.attempt + (startsAttempt ? 1 : 0),
    updatedAt: now,
    ...(TERMINAL_STATES.has(nextStatus) ? { completedAt: now } : {}),
    version: task.version + 1,
  };
}

export function isAgentTaskTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATES.has(status);
}

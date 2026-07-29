import { DomainError } from '../shared/domain-error.js';
import type {
  AgentRunId,
  ConversationBranchId,
  PlanRevisionId,
  RootRequestId,
  WorkspaceId,
} from '../shared/ids.js';
import { transitionState } from '../shared/transition.js';

export const AGENT_RUN_STATES = [
  'queued',
  'planning',
  'running',
  'waiting_for_approval',
  'waiting_for_user',
  'cancelling',
  'cancelled',
  'interrupted',
  'recovering',
  'completed',
  'completed_with_degradation',
  'failed',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATES)[number];
export type AgentRunMode = 'direct' | 'planned';

const TERMINAL_STATES: ReadonlySet<AgentRunStatus> = new Set([
  'cancelled',
  'completed',
  'completed_with_degradation',
  'failed',
]);

const TRANSITIONS: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  queued: ['planning', 'cancelling'],
  planning: ['running', 'cancelling', 'interrupted'],
  running: [
    'waiting_for_approval',
    'waiting_for_user',
    'completed',
    'completed_with_degradation',
    'failed',
    'cancelling',
    'interrupted',
  ],
  waiting_for_approval: ['running', 'cancelling', 'interrupted'],
  waiting_for_user: ['running', 'cancelling', 'interrupted'],
  cancelling: ['cancelled'],
  cancelled: [],
  interrupted: ['recovering'],
  recovering: ['planning', 'running', 'waiting_for_user', 'failed'],
  completed: [],
  completed_with_degradation: [],
  failed: [],
};

export type AgentRun = {
  readonly id: AgentRunId;
  readonly workspaceId: WorkspaceId;
  readonly conversationBranchId: ConversationBranchId;
  readonly rootRequestId: RootRequestId;
  readonly mode: AgentRunMode;
  readonly status: AgentRunStatus;
  readonly activePlanRevisionId?: PlanRevisionId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
  readonly version: number;
};

export type CreateAgentRun = {
  readonly id: AgentRunId;
  readonly workspaceId: WorkspaceId;
  readonly conversationBranchId: ConversationBranchId;
  readonly rootRequestId: RootRequestId;
  readonly mode: AgentRunMode;
  readonly now: Date;
};

export function createAgentRun(input: CreateAgentRun): AgentRun {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    conversationBranchId: input.conversationBranchId,
    rootRequestId: input.rootRequestId,
    mode: input.mode,
    status: 'queued',
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
  };
}

export function transitionAgentRun(run: AgentRun, status: AgentRunStatus, now: Date): AgentRun {
  if (
    run.mode === 'planned' &&
    status === 'running' &&
    run.activePlanRevisionId === undefined &&
    run.status !== 'recovering'
  ) {
    throw new DomainError(
      'invariant_violation',
      'A Planned Run cannot run before its Execution Plan is persisted',
      { runId: run.id, status: run.status },
    );
  }

  const nextStatus = transitionState('AgentRun', run.status, status, TRANSITIONS, TERMINAL_STATES);
  const terminal = TERMINAL_STATES.has(nextStatus);

  return {
    ...run,
    status: nextStatus,
    updatedAt: now,
    ...(terminal ? { completedAt: now } : {}),
    version: run.version + 1,
  };
}

export function attachPlanRevision(
  run: AgentRun,
  activePlanRevisionId: PlanRevisionId,
  now: Date,
): AgentRun {
  if (run.mode !== 'planned') {
    throw new DomainError('invariant_violation', 'A Direct Run cannot own an Execution Plan', {
      runId: run.id,
      mode: run.mode,
    });
  }

  if (TERMINAL_STATES.has(run.status)) {
    throw new DomainError('terminal_state', 'A terminal Agent Run cannot accept a plan', {
      runId: run.id,
      status: run.status,
    });
  }

  return {
    ...run,
    activePlanRevisionId,
    updatedAt: now,
    version: run.version + 1,
  };
}

export function promoteDirectRunToPlanned(run: AgentRun, now: Date): AgentRun {
  if (run.mode !== 'direct' || run.status !== 'planning') {
    throw new DomainError(
      'invariant_violation',
      'Only a Direct Run in planning may be promoted to Planned',
      { runId: run.id, mode: run.mode, status: run.status },
    );
  }

  return {
    ...run,
    mode: 'planned',
    updatedAt: now,
    version: run.version + 1,
  };
}

export function isAgentRunTerminal(status: AgentRunStatus): boolean {
  return TERMINAL_STATES.has(status);
}

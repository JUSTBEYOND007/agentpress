import { DomainError } from '../shared/domain-error.js';
import type { AgentRunId, AgentTaskId, ApprovalId, ToolCallId } from '../shared/ids.js';
import { transitionState } from '../shared/transition.js';

export const TOOL_CALL_STATES = [
  'proposed',
  'awaiting_approval',
  'approved',
  'denied',
  'expired',
  'executing',
  'succeeded',
  'failed',
  'outcome_unknown',
  'cancelled',
] as const;

export type ToolCallStatus = (typeof TOOL_CALL_STATES)[number];
export type ToolRisk = 'read_only' | 'draft_write' | 'external_write' | 'destructive';

const TERMINAL_STATES: ReadonlySet<ToolCallStatus> = new Set([
  'denied',
  'expired',
  'succeeded',
  'failed',
  'outcome_unknown',
  'cancelled',
]);

const TRANSITIONS: Readonly<Record<ToolCallStatus, readonly ToolCallStatus[]>> = {
  proposed: ['awaiting_approval', 'executing', 'cancelled'],
  awaiting_approval: ['approved', 'denied', 'expired', 'cancelled'],
  approved: ['executing', 'cancelled'],
  denied: [],
  expired: [],
  executing: ['succeeded', 'failed', 'outcome_unknown'],
  succeeded: [],
  failed: [],
  outcome_unknown: [],
  cancelled: [],
};

export type ToolCall = {
  readonly id: ToolCallId;
  readonly runId: AgentRunId;
  readonly taskId?: AgentTaskId;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly evidenceProviderRevision?: string;
  readonly argumentsHash: string;
  readonly risk: ToolRisk;
  readonly idempotencyKey?: string;
  readonly status: ToolCallStatus;
  readonly approvalId?: ApprovalId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly settledAt?: Date;
  readonly version: number;
};

export type CreateToolCall = {
  readonly now: Date;
} & Omit<ToolCall, 'status' | 'approvalId' | 'createdAt' | 'updatedAt' | 'settledAt' | 'version'>;

export function createToolCall(input: CreateToolCall): ToolCall {
  return {
    id: input.id,
    runId: input.runId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    toolId: input.toolId,
    toolVersion: input.toolVersion,
    ...(input.evidenceProviderRevision
      ? { evidenceProviderRevision: input.evidenceProviderRevision }
      : {}),
    argumentsHash: input.argumentsHash,
    risk: input.risk,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    status: 'proposed',
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
  };
}

export function transitionToolCall(
  call: ToolCall,
  status: ToolCallStatus,
  now: Date,
  approvalId?: ApprovalId,
): ToolCall {
  const nextStatus = transitionState('ToolCall', call.status, status, TRANSITIONS, TERMINAL_STATES);

  if (status === 'approved' && approvalId === undefined) {
    throw new DomainError('invariant_violation', 'An approved Tool Call requires an Approval ID', {
      toolCallId: call.id,
    });
  }
  if (
    status === 'executing' &&
    (call.risk === 'external_write' || call.risk === 'destructive') &&
    call.status !== 'approved'
  ) {
    throw new DomainError(
      'invariant_violation',
      'A side-effecting Tool Call cannot execute without exact approval',
      { toolCallId: call.id, risk: call.risk, status: call.status },
    );
  }

  return {
    ...call,
    status: nextStatus,
    ...(approvalId ? { approvalId } : {}),
    updatedAt: now,
    ...(TERMINAL_STATES.has(nextStatus) ? { settledAt: now } : {}),
    version: call.version + 1,
  };
}

export function isToolCallTerminal(status: ToolCallStatus): boolean {
  return TERMINAL_STATES.has(status);
}

export function isToolCallRetryable(status: ToolCallStatus): boolean {
  return status === 'failed';
}

import type { AgentPressDatabase } from '@agentpress/database';
import type { ToolRegistry } from '@agentpress/tool-runtime';

import type { RunEventPublisher } from './contracts.js';

export const APPROVAL_RISKS = new Set(['external_write', 'destructive']);

export class ToolCallApplicationError extends Error {
  public constructor(
    public readonly code:
      | 'run_not_found'
      | 'tool_call_not_found'
      | 'approval_not_found'
      | 'approval_expired'
      | 'approval_mismatch'
      | 'approval_denied'
      | 'invalid_tool_state'
      | 'stale_task_attempt'
      | 'tool_replay_blocked'
      | 'unauthorized_tool',
    message: string,
  ) {
    super(message);
    this.name = 'ToolCallApplicationError';
  }
}

export type ProposeToolCallInput = {
  readonly runId: string;
  readonly taskId?: string;
  readonly taskAttempt?: number;
  readonly taskOperationKey?: string;
  readonly taskOperationOrdinal?: number;
  readonly providerToolCallId?: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly requestedFromUserId: string;
  readonly allowedCapabilities: ReadonlySet<string>;
  readonly idempotencyKey?: string;
};

export type DecideToolCallApprovalInput = {
  readonly toolCallId: string;
  readonly decision: 'approved' | 'denied';
  readonly userId: string;
};

export type ToolCallServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly registry: ToolRegistry;
  readonly publisher: RunEventPublisher;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly approvalTtlMs?: number;
};

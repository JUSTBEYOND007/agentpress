import type { AgentPressDatabase, DatabaseTransaction } from '@agentpress/database';
import type { ToolDefinition, ToolRegistry } from '@agentpress/tool-runtime';

import type { RunEventPublisher } from './contracts.js';
import type { PersistedToolEvidence, PersistToolEvidenceInput } from './tool-evidence-store.js';

export const APPROVAL_RISKS = new Set(['external_write', 'destructive']);

export function transportProvenanceMatches(
  stored: unknown,
  expected: ToolDefinition['transport'] | undefined,
): boolean {
  if (!expected) return stored === null || stored === undefined;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
  const record = stored as Record<string, unknown>;
  return (
    record.kind === expected.kind &&
    record.serverId === expected.serverId &&
    record.serverRevision === expected.serverRevision &&
    record.toolName === expected.toolName &&
    record.toolRevision === expected.toolRevision &&
    record.adapterRevision === expected.adapterRevision
  );
}

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

export type RecordToolPreflightFailureInput = {
  readonly runId: string;
  readonly taskId?: string;
  readonly taskAttempt?: number;
  readonly providerToolCallId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly arguments: unknown;
  readonly failure: string;
  readonly allowedCapabilities: ReadonlySet<string>;
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
  readonly evidenceProjector?: (
    transaction: DatabaseTransaction,
    input: PersistToolEvidenceInput,
  ) => Promise<readonly PersistedToolEvidence[] | undefined>;
};

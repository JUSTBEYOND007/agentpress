export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type ConversationBranchId = Brand<string, 'ConversationBranchId'>;
export type RootRequestId = Brand<string, 'RootRequestId'>;
export type AgentRunId = Brand<string, 'AgentRunId'>;
export type ExecutionPlanId = Brand<string, 'ExecutionPlanId'>;
export type PlanRevisionId = Brand<string, 'PlanRevisionId'>;
export type AgentTaskId = Brand<string, 'AgentTaskId'>;
export type ToolCallId = Brand<string, 'ToolCallId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type CheckpointId = Brand<string, 'CheckpointId'>;

export const asWorkspaceId = (value: string): WorkspaceId => value as WorkspaceId;
export const asConversationId = (value: string): ConversationId => value as ConversationId;
export const asConversationBranchId = (value: string): ConversationBranchId =>
  value as ConversationBranchId;
export const asRootRequestId = (value: string): RootRequestId => value as RootRequestId;
export const asAgentRunId = (value: string): AgentRunId => value as AgentRunId;
export const asExecutionPlanId = (value: string): ExecutionPlanId => value as ExecutionPlanId;
export const asPlanRevisionId = (value: string): PlanRevisionId => value as PlanRevisionId;
export const asAgentTaskId = (value: string): AgentTaskId => value as AgentTaskId;
export const asToolCallId = (value: string): ToolCallId => value as ToolCallId;
export const asApprovalId = (value: string): ApprovalId => value as ApprovalId;
export const asCheckpointId = (value: string): CheckpointId => value as CheckpointId;

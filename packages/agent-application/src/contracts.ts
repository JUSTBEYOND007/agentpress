import type { AgentRuntime, RuntimeEvent, RuntimeTool } from '@agentpress/agent-runtime';

export const AGENT_RUN_COMMAND_TOPIC = 'agent.run.commands';
export const AGENT_RUN_CANCEL_CHANNEL = 'agentpress:run:cancel';

export type DurableRunEvent = {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
};

export type LiveRunEvent =
  | {
      readonly durable: true;
      readonly event: DurableRunEvent;
    }
  | {
      readonly durable: false;
      readonly runId: string;
      readonly event: RuntimeEvent;
    };

export type RunEventPublisher = {
  publish(event: LiveRunEvent): Promise<void>;
};

export type AgentRuntimeFactory = {
  create(): AgentRuntime;
};

export type RuntimeToolFactory = {
  createForRun(runId: string): Promise<readonly RuntimeTool[]>;
};

export type SelectedSkillInput = {
  readonly skillId: string;
  readonly version: string;
};

export type CreateDirectRunInput = {
  readonly conversationId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly idempotencyKey: string;
  readonly mentionTargetIds?: readonly string[];
  readonly skills?: readonly SelectedSkillInput[];
};

export type CreateDirectRunResult = {
  readonly runId: string;
  readonly rootRequestId: string;
  readonly messageId: string;
  readonly status: string;
  readonly mode: 'direct' | 'planned';
  readonly created: boolean;
};

export type ExecuteDirectRunResult = {
  readonly runId: string;
  readonly status: 'completed' | 'completed_with_degradation' | 'cancelled' | 'failed' | 'ignored';
};

export type RequestRunCancellationResult =
  | { readonly outcome: 'accepted'; readonly runId: string; readonly status: 'cancelling' }
  | { readonly outcome: 'already_terminal'; readonly runId: string; readonly status: string }
  | { readonly outcome: 'not_found'; readonly runId: string };

export class AgentApplicationError extends Error {
  public constructor(
    public readonly code:
      | 'conversation_not_found'
      | 'branch_not_found'
      | 'invalid_prompt'
      | 'invalid_context'
      | 'invalid_directive'
      | 'unauthorized_user'
      | 'unauthorized_context'
      | 'run_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'AgentApplicationError';
  }
}

export type EnqueueRunDirectiveResult = {
  readonly directiveId: string;
  readonly runId: string;
  readonly kind: 'steering' | 'follow_up';
  readonly sequence: number;
  readonly status: 'pending';
};

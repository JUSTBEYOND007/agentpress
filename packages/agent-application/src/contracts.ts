import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeTool,
  RuntimeToolResultMessage,
} from '@agentpress/agent-runtime';

export const AGENT_RUN_COMMAND_TOPIC = 'agent.run.commands';
export const AGENT_TASK_COMMAND_TOPIC = 'agent.task.commands';
export const AGENT_RUN_CANCEL_CHANNEL = 'agentpress:run:cancel';
export const AGENT_RUN_STEER_CHANNEL = 'agentpress:run:steer';

export type RunSteeringCommand = {
  readonly runId: string;
  readonly directiveId: string;
  readonly content: string;
};

export type AgentTaskExecuteCommand = {
  readonly command: 'task.execute';
  readonly messageId: string;
  readonly runId: string;
  readonly taskId: string;
};

export function parseAgentTaskExecuteCommand(value: unknown): AgentTaskExecuteCommand | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.command !== 'task.execute' ||
    typeof candidate.messageId !== 'string' ||
    typeof candidate.runId !== 'string' ||
    typeof candidate.taskId !== 'string'
  ) {
    return undefined;
  }
  return candidate as AgentTaskExecuteCommand;
}

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
  create(task?: string): AgentRuntime;
};

export type RuntimeToolFactory = {
  createForRun(
    runId: string,
    capabilities?: readonly string[],
    taskId?: string,
    taskAttempt?: number,
  ): Promise<readonly RuntimeTool[]>;
  listCapabilities(runId: string): Promise<readonly string[]>;
  resumeApprovedToolCall?(
    runId: string,
    taskId: string,
    providerToolCallId: string,
  ): Promise<RuntimeToolResultMessage | undefined>;
};

export type SkillPreselectionCandidate = {
  readonly skillId: string;
  readonly version: string;
  readonly description: string;
  readonly allowedTools: readonly string[];
  readonly hidden: boolean;
  readonly disableModelInvocation: boolean;
};

export type SkillPreselectionRequest = {
  readonly prompt: string;
  readonly explicitSkills: readonly SelectedSkillInput[];
  readonly candidates: readonly SkillPreselectionCandidate[];
  readonly maxSelections?: number;
  readonly signal?: AbortSignal;
};

export type SkillPreselector = {
  select(input: SkillPreselectionRequest): Promise<readonly SelectedSkillInput[]>;
};

export type SelectedSkillInput = {
  readonly skillId: string;
  readonly version: string;
};

export type SkillCatalogFailure = {
  readonly skillId: string;
  readonly version: string;
  readonly code: 'load_failed' | 'identity_mismatch';
};

export type RunContextBinding =
  | { readonly type: 'mention'; readonly targetId: string }
  | { readonly type: 'attachment'; readonly attachmentId: string }
  | { readonly type: 'evidence'; readonly evidenceId: string }
  | {
      readonly type: 'article_revision';
      readonly articleId: string;
      readonly revisionId: string;
    }
  | {
      readonly type: 'article_selection';
      readonly articleId: string;
      readonly revisionId: string;
      readonly blocks: readonly { readonly blockId: string; readonly contentHash: string }[];
    }
  | ({ readonly type: 'skill' } & SelectedSkillInput);

export type CreateDirectRunInput = {
  readonly conversationId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly idempotencyKey: string;
  readonly existingMessageId?: string;
  readonly contextBindings?: readonly RunContextBinding[];
  readonly mentionTargetIds?: readonly string[];
  readonly attachmentIds?: readonly string[];
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

/** The command lost its durable worker lease before settlement could commit. */
export class StaleWorkerSettlementError extends Error {
  public constructor(runId: string) {
    super(`Agent Run ${runId} rejected stale worker settlement during recovery`);
    this.name = 'StaleWorkerSettlementError';
  }
}

export type EnqueueRunDirectiveResult = {
  readonly directiveId: string;
  readonly runId: string;
  readonly kind: 'steering' | 'follow_up';
  readonly sequence: number;
  readonly status: 'pending';
};

export type RunPart = {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type:
    | 'text'
    | 'reasoning'
    | 'plan'
    | 'action-proposal'
    | 'activity'
    | 'tool-approval'
    | 'ask-user'
    | 'evidence'
    | 'article-change'
    | 'artifact'
    | 'warning'
    | 'recovery'
    | 'progress'
    | 'usage';
  readonly status: string;
  readonly outcome?: ActivityOutcome;
  readonly correlationId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

/** Host-owned semantic outcome for an execution activity; never inferred by the UI. */
export type ActivityOutcome =
  | 'succeeded'
  | 'degraded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'
  | 'stale'
  | 'outcome_unknown';

export type RunProjection = {
  readonly runId: string;
  readonly rootMessageId: string;
  readonly status: string;
  readonly terminal: boolean;
  readonly mode: 'direct' | 'planned';
  readonly activePlanRevision?: number;
  readonly parts: readonly RunPart[];
  readonly artifacts: readonly Readonly<Record<string, unknown>>[];
  readonly agents: readonly AgentRegistryProjection[];
  readonly context?: Readonly<Record<string, unknown>>;
  readonly pendingInteraction?: Readonly<Record<string, unknown>>;
  readonly pendingDirectives: readonly {
    readonly id: string;
    readonly kind: 'steering' | 'follow_up';
    readonly content: string;
    readonly sequence: number;
    readonly createdAt: string;
  }[];
  readonly lastEventId: number;
  readonly createdAt: string;
  readonly completedAt?: string;
};

export type AgentRegistryProjection = {
  readonly registryId: string;
  readonly kind: 'main' | 'specialist';
  readonly runId: string;
  readonly taskId?: string;
  readonly owner: string;
  readonly status: string;
  readonly attempt: number;
  readonly updatedAt: string;
  readonly lastEvent?: {
    readonly sequence: number;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  };
};

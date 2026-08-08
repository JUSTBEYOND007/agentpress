export type AgentSendMode = 'steering' | 'follow-up';

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
    | 'context'
    | 'warning'
    | 'recovery'
    | 'progress'
    | 'usage';
  readonly status: string;
  readonly outcome?: ActivityOutcome;
  readonly correlationId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

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
  readonly agents: readonly {
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
  }[];
  readonly context?: Readonly<Record<string, unknown>>;
  readonly pendingInteraction?: Readonly<Record<string, unknown>>;
  readonly pendingDirectives: readonly PendingDirective[];
  readonly lastEventId: number;
  readonly createdAt: string;
  readonly completedAt?: string;
};

export type RunProcessPresentation = {
  readonly runId: string;
  readonly status: string;
  readonly terminal: boolean;
  readonly durationMs: number;
  readonly parts: readonly RunPart[];
  readonly items: readonly ConsumerExecutionItem[];
};

export type ConsumerExecutionStatus =
  | 'running'
  | 'processing'
  | 'completed'
  | 'degraded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'
  | 'stale'
  | 'outcome_unknown';

export type ConsumerExecutionStage = {
  readonly id: string;
  readonly label: string;
  readonly status: ConsumerExecutionStatus;
  readonly progress?: Readonly<Record<string, unknown>>;
};

export type ToolActivityAudit = {
  readonly kind: 'mcp';
  readonly serverId: string;
  readonly serverRevision: string;
  readonly toolName: string;
  readonly toolRevision: string;
  readonly adapterRevision: string;
  readonly taskAttempt?: number;
  readonly durationMs?: number;
  readonly transportRetryCount?: number;
  readonly transportReconnectCount?: number;
  readonly argumentNames: readonly string[];
  readonly argumentCount: number;
  readonly argumentSummary?: {
    readonly schemaVersion: 1;
    readonly fieldCount: number;
    readonly additionalFieldCount: number;
    readonly fields: readonly {
      readonly name: string;
      readonly required: boolean;
      readonly schemaTypes: readonly string[];
      readonly valueType: string;
      readonly stringLength?: number;
      readonly arrayLength?: number;
      readonly objectKeyCount?: number;
    }[];
  };
  readonly outputReference?: {
    readonly artifactId: string;
    readonly versionId?: string;
    readonly uri?: string;
  };
};

export type ConsumerExecutionItem =
  | {
      readonly kind: 'pipeline';
      readonly id: string;
      readonly label: string;
      readonly status: ConsumerExecutionStatus;
      readonly durationMs: number;
      readonly stages: readonly ConsumerExecutionStage[];
      readonly result?: unknown;
      readonly error?: string;
      readonly audit?: ToolActivityAudit;
      readonly sequence: number;
    }
  | {
      readonly kind: 'utility-group';
      readonly id: string;
      readonly count: number;
      readonly status: ConsumerExecutionStatus;
      readonly items: readonly {
        readonly id: string;
        readonly label: string;
        readonly status: ConsumerExecutionStatus;
        readonly result?: unknown;
        readonly audit?: ToolActivityAudit;
        readonly sequence: number;
      }[];
      readonly sequence: number;
    };

export type ArticleOutcomePresentation = {
  readonly part: RunPart;
  readonly process: RunProcessPresentation;
};

export type PendingDirective = {
  readonly id: string;
  readonly kind: 'steering' | 'follow_up';
  readonly content: string;
  readonly sequence: number;
  readonly createdAt: string;
};

export type AgentContextBinding =
  | { readonly type: 'mention'; readonly targetId: string }
  | { readonly type: 'attachment'; readonly attachmentId: string }
  | { readonly type: 'evidence'; readonly evidenceId: string }
  | {
      readonly type: 'article_selection';
      readonly articleId: string;
      readonly revisionId: string;
      readonly blocks: readonly { readonly blockId: string; readonly contentHash: string }[];
    }
  | { readonly type: 'skill'; readonly skillId: string; readonly version: string };

export type AgentMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text?: string;
  readonly projection?: RunProjection;
  readonly status?: 'running' | 'complete' | 'error';
};

export type AgentRuntimeReadiness =
  | { readonly status: 'checking'; readonly missing: readonly string[] }
  | { readonly status: 'ready'; readonly missing: readonly string[] }
  | { readonly status: 'unavailable'; readonly missing: readonly string[] };

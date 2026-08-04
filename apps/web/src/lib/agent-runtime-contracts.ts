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
  readonly payload: Readonly<Record<string, unknown>>;
};

export type RunProjection = {
  readonly runId: string;
  readonly rootMessageId: string;
  readonly status: string;
  readonly terminal: boolean;
  readonly mode: 'direct' | 'planned';
  readonly activePlanRevision?: number;
  readonly parts: readonly RunPart[];
  readonly artifacts: readonly Readonly<Record<string, unknown>>[];
  readonly context?: Readonly<Record<string, unknown>>;
  readonly pendingInteraction?: Readonly<Record<string, unknown>>;
  readonly pendingDirectives: readonly PendingDirective[];
  readonly lastEventId: number;
  readonly createdAt: string;
  readonly completedAt?: string;
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

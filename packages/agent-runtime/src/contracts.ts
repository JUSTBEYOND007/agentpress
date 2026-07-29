export type RuntimeUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
};

export type RuntimeUserMessage = {
  readonly role: 'user';
  readonly content: string;
  readonly timestamp: number;
};

export type RuntimeAssistantMessage = {
  readonly role: 'assistant';
  readonly content: string;
  readonly provider: string;
  readonly model: string;
  readonly responseId?: string;
  readonly stopReason: 'stop' | 'length' | 'tool_use' | 'error' | 'aborted';
  readonly errorMessage?: string;
  readonly usage: RuntimeUsage;
  readonly timestamp: number;
};

export type RuntimeMessage = RuntimeUserMessage | RuntimeAssistantMessage;

export type RuntimeEvent =
  | { readonly type: 'run.started' }
  | { readonly type: 'turn.started' }
  | { readonly type: 'message.started'; readonly role: RuntimeMessage['role'] }
  | { readonly type: 'content.delta'; readonly delta: string }
  | { readonly type: 'message.completed'; readonly message: RuntimeMessage }
  | { readonly type: 'usage.updated'; readonly usage: RuntimeUsage }
  | { readonly type: 'run.completed'; readonly messages: readonly RuntimeMessage[] }
  | { readonly type: 'run.cancelled' }
  | { readonly type: 'run.failed'; readonly error: RuntimeFailure };

export type RuntimeFailure = {
  readonly code: 'provider_error' | 'invalid_history' | 'runtime_error';
  readonly message: string;
  readonly retryable: boolean;
};

export type RuntimeRequest = {
  readonly runId: string;
  readonly systemPrompt: string;
  readonly history: readonly RuntimeMessage[];
  readonly prompt: string;
};

export type RuntimeResult =
  | {
      readonly status: 'completed';
      readonly messages: readonly RuntimeMessage[];
    }
  | {
      readonly status: 'cancelled';
      readonly messages: readonly RuntimeMessage[];
    }
  | {
      readonly status: 'failed';
      readonly messages: readonly RuntimeMessage[];
      readonly error: RuntimeFailure;
    };

export type RuntimeEventSink = (event: RuntimeEvent) => Promise<void> | void;

export type AgentRuntime = {
  execute(
    request: RuntimeRequest,
    sink: RuntimeEventSink,
    signal?: AbortSignal,
  ): Promise<RuntimeResult>;
};

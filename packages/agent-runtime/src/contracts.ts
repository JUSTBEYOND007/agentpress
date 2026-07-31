import type { TSchema } from 'typebox';

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

export type RuntimeToolCall = {
  readonly type: 'tool_call';
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
};

export type RuntimeToolResultMessage = {
  readonly role: 'tool';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly details?: unknown;
  readonly isError: boolean;
  readonly timestamp: number;
};

export type RuntimeAssistantMessage = {
  readonly role: 'assistant';
  readonly content: string;
  readonly parts?: readonly RuntimeToolCall[];
  readonly provider: string;
  readonly model: string;
  readonly responseId?: string;
  readonly stopReason: 'stop' | 'length' | 'tool_use' | 'error' | 'aborted';
  readonly errorMessage?: string;
  readonly usage: RuntimeUsage;
  readonly timestamp: number;
};

export type RuntimeMessage = RuntimeUserMessage | RuntimeAssistantMessage;
export type RuntimeTranscriptMessage = RuntimeMessage | RuntimeToolResultMessage;

export type RuntimeEvent =
  | { readonly type: 'run.started' }
  | { readonly type: 'turn.started' }
  | { readonly type: 'message.started'; readonly role: RuntimeMessage['role'] }
  | { readonly type: 'content.delta'; readonly delta: string }
  | { readonly type: 'message.completed'; readonly message: RuntimeMessage }
  | {
      readonly type: 'tool.started';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: 'tool.updated';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly details?: unknown;
    }
  | { readonly type: 'tool.completed'; readonly result: RuntimeToolResultMessage }
  | { readonly type: 'usage.updated'; readonly usage: RuntimeUsage }
  | { readonly type: 'run.completed'; readonly messages: readonly RuntimeMessage[] }
  | { readonly type: 'run.cancelled' }
  | { readonly type: 'run.failed'; readonly error: RuntimeFailure };

export type RuntimeFailure = {
  readonly code:
    | 'provider_error'
    | 'invalid_history'
    | 'protocol_error'
    | 'runtime_error';
  readonly message: string;
  readonly retryable: boolean;
};

export type RuntimeRequest = {
  readonly runId: string;
  readonly systemPrompt: string;
  readonly history: readonly RuntimeMessage[];
  readonly prompt: string;
  readonly tools?: readonly RuntimeTool[];
};

export type RuntimeTool = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly constrainedSampling?: false | {
    readonly type: 'json_schema';
    readonly strict: 'prefer' | 'require';
  };
  readonly executionMode?: 'sequential' | 'parallel';
  readonly output?: 'json' | 'text';
  readonly terminateOnSuccess?: boolean;
  readonly execute: (
    arguments_: Readonly<Record<string, unknown>>,
    context: {
      readonly runId: string;
      readonly providerToolCallId: string;
      readonly signal?: AbortSignal;
      readonly onUpdate?: (details: unknown) => void;
    },
  ) => Promise<unknown>;
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

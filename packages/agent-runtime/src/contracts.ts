import type { TSchema } from 'typebox';

import type { RuntimeCurrentTurn } from './current-turn.js';

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

export type RuntimeAssistantContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string }
  | RuntimeToolCall;

export type RuntimeToolResultMessage = {
  readonly role: 'tool';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly details?: unknown;
  readonly usage?: RuntimeUsage;
  readonly terminate?: boolean;
  readonly addedToolNames?: readonly string[];
  readonly isError: boolean;
  readonly timestamp: number;
};

export type RuntimeAssistantMessage = {
  readonly role: 'assistant';
  readonly content: string;
  readonly blocks?: readonly RuntimeAssistantContentBlock[];
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
  readonly code: 'provider_error' | 'invalid_history' | 'protocol_error' | 'runtime_error';
  readonly message: string;
  readonly retryable: boolean;
};

export type RuntimeRequest = {
  readonly runId: string;
  readonly systemPrompt: string;
  readonly history: readonly RuntimeTranscriptMessage[];
  readonly currentTurn: RuntimeCurrentTurn;
  readonly tools?: readonly RuntimeTool[];
  readonly continuation?: boolean;
  readonly maxToolCalls?: number;
  readonly maxFailedCompletionCalls?: number;
  readonly beforeToolCall?: (
    context: RuntimeBeforeToolCallContext,
  ) => Promise<RuntimeBeforeToolCallResult | undefined> | RuntimeBeforeToolCallResult | undefined;
  readonly afterToolCall?: (
    context: RuntimeAfterToolCallContext,
  ) => Promise<RuntimeAfterToolCallResult | undefined> | RuntimeAfterToolCallResult | undefined;
};

export type RuntimeBeforeToolCallContext = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
};

export type RuntimeBeforeToolCallResult = { readonly block?: boolean; readonly reason?: string };

export type RuntimeAfterToolCallContext = RuntimeBeforeToolCallContext & {
  readonly result: RuntimeToolResultMessage;
};

export type RuntimeAfterToolCallResult = {
  readonly content?: string;
  readonly details?: unknown;
  readonly isError?: boolean;
  readonly usage?: RuntimeUsage;
  readonly terminate?: boolean;
  readonly addedToolNames?: readonly string[];
};

export type RuntimeTool = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly constrainedSampling?:
    | false
    | {
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
  readonly identity?: {
    readonly provider: string;
    readonly model: string;
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
  };
  execute(
    request: RuntimeRequest,
    sink: RuntimeEventSink,
    signal?: AbortSignal,
  ): Promise<RuntimeResult>;
  steer?(message: RuntimeUserMessage): boolean;
};

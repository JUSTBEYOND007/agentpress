import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import {
  contentText,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type Models,
  type UserMessage,
} from '@earendil-works/pi-ai';

import { createArkBackend, type ArkRuntimeConfig } from './ark-provider.js';
import type {
  AgentRuntime,
  RuntimeAssistantMessage,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeFailure,
  RuntimeMessage,
  RuntimeRequest,
  RuntimeResult,
  RuntimeTool,
  RuntimeToolResultMessage,
  RuntimeUsage,
} from './contracts.js';

type PiBackend = {
  readonly models: Models;
  readonly model: Model<Api>;
};

class ExecutionState {
  private cancelled: boolean;
  public failure?: RuntimeFailure;

  public constructor(cancelled: boolean) {
    this.cancelled = cancelled;
  }

  public cancel(): void {
    this.cancelled = true;
  }

  public isCancelled(): boolean {
    return this.cancelled;
  }
}

export type FauxRuntimeConfig = {
  readonly responses: readonly (string | AssistantMessage)[];
  readonly tokensPerSecond?: number;
};

export class PiRuntimeAdapter implements AgentRuntime {
  private constructor(private readonly backend: PiBackend) {}

  public static forArk(config: ArkRuntimeConfig): PiRuntimeAdapter {
    return new PiRuntimeAdapter(createArkBackend(config));
  }

  public static forTests(config: FauxRuntimeConfig): PiRuntimeAdapter {
    const faux = fauxProvider({
      ...(config.tokensPerSecond === undefined ? {} : { tokensPerSecond: config.tokensPerSecond }),
    });
    faux.setResponses(
      config.responses.map((response) =>
        typeof response === 'string' ? fauxAssistantMessage(response) : response,
      ),
    );
    const models = createModels();
    models.setProvider(faux.provider);

    return new PiRuntimeAdapter({ models, model: faux.getModel() });
  }

  public async execute(
    request: RuntimeRequest,
    sink: RuntimeEventSink,
    signal?: AbortSignal,
  ): Promise<RuntimeResult> {
    const stableMessages: RuntimeMessage[] = [...request.history];
    const agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt,
        model: this.backend.model,
        messages: request.history.map(toPiMessage),
        tools: request.tools?.map((tool) => toPiTool(tool, request.runId)) ?? [],
        thinkingLevel: 'off',
      },
      streamFn: this.backend.models.streamSimple.bind(this.backend.models),
      sessionId: request.runId,
      maxRetryDelayMs: 10_000,
    });
    const state = new ExecutionState(signal?.aborted ?? false);
    const abort = (): void => {
      state.cancel();
      agent.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });

    const unsubscribe = agent.subscribe(async (event) => {
      const normalized = normalizeEvent(event);
      for (const runtimeEvent of normalized) {
        if (runtimeEvent.type === 'message.completed') {
          if (runtimeEvent.message.role === 'assistant') {
            stableMessages.push(runtimeEvent.message);
            if (runtimeEvent.message.stopReason === 'error') {
              state.failure = {
                code: 'provider_error',
                message: runtimeEvent.message.errorMessage ?? 'Provider returned an error',
                retryable: true,
              };
            }
            if (runtimeEvent.message.stopReason === 'aborted') {
              state.cancel();
            }
          }
        }
        await sink(runtimeEvent);
      }
    });

    try {
      if (state.isCancelled()) {
        await sink({ type: 'run.cancelled' });
        return { status: 'cancelled', messages: stableMessages };
      }

      await agent.prompt(request.prompt);

      if (state.isCancelled()) {
        await sink({ type: 'run.cancelled' });
        return { status: 'cancelled', messages: stableMessages };
      }
      if (state.failure) {
        await sink({ type: 'run.failed', error: state.failure });
        return { status: 'failed', messages: stableMessages, error: state.failure };
      }

      await sink({ type: 'run.completed', messages: stableMessages });
      return { status: 'completed', messages: stableMessages };
    } catch (error) {
      const runtimeFailure: RuntimeFailure = {
        code: 'runtime_error',
        message: error instanceof Error ? error.message : 'Unknown Pi runtime error',
        retryable: !state.isCancelled(),
      };
      if (state.isCancelled()) {
        await sink({ type: 'run.cancelled' });
        return { status: 'cancelled', messages: stableMessages };
      }
      await sink({ type: 'run.failed', error: runtimeFailure });
      return { status: 'failed', messages: stableMessages, error: runtimeFailure };
    } finally {
      signal?.removeEventListener('abort', abort);
      unsubscribe();
    }
  }
}

function toPiTool(tool: RuntimeTool, runId: string): AgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    execute: async (providerToolCallId, parameters, signal, onUpdate) => {
      const output = await tool.execute(parameters as Readonly<Record<string, unknown>>, {
        runId,
        providerToolCallId,
        ...(signal ? { signal } : {}),
        ...(onUpdate ? { onUpdate: (details: unknown) => onUpdate({
          content: [{ type: 'text', text: serializeToolOutput(details) }],
          details,
        }) } : {}),
      });
      return {
        content: [{ type: 'text', text: serializeToolOutput(output) }],
        details: output,
        ...(tool.terminateOnSuccess ? { terminate: true } : {}),
      };
    },
  };
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return 'null';
  return JSON.stringify(output);
}

function normalizeEvent(event: AgentEvent): readonly RuntimeEvent[] {
  switch (event.type) {
    case 'agent_start':
      return [{ type: 'run.started' }];
    case 'turn_start':
      return [{ type: 'turn.started' }];
    case 'message_start':
      return isSupportedMessage(event.message)
        ? [{ type: 'message.started', role: normalizeRole(event.message) }]
        : [];
    case 'message_update':
      return event.assistantMessageEvent.type === 'text_delta'
        ? [{ type: 'content.delta', delta: event.assistantMessageEvent.delta }]
        : [];
    case 'message_end': {
      const message = toRuntimeMessage(event.message);
      if (!message) {
        return [];
      }
      return message.role === 'assistant'
        ? [
            { type: 'message.completed', message },
            { type: 'usage.updated', usage: message.usage },
          ]
        : [{ type: 'message.completed', message }];
    }
    case 'tool_execution_start':
      return [
        {
          type: 'tool.started',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.args as Readonly<Record<string, unknown>>,
        },
      ];
    case 'tool_execution_update':
      return [
        {
          type: 'tool.updated',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          details: event.partialResult,
        },
      ];
    case 'tool_execution_end': {
      const result = event.result as {
        readonly content?: readonly { readonly type: 'text'; readonly text: string }[];
        readonly details?: unknown;
      };
      const toolResult: RuntimeToolResultMessage = {
        role: 'tool',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        content: result.content?.map(({ text }) => text).join('') ?? '',
        ...(result.details === undefined ? {} : { details: result.details }),
        isError: event.isError,
        timestamp: Date.now(),
      };
      return [{ type: 'tool.completed', result: toolResult }];
    }
    case 'agent_end':
    case 'turn_end':
      return [];
  }
}

function isSupportedMessage(message: AgentMessage): message is UserMessage | AssistantMessage {
  return (
    typeof message === 'object' &&
    'role' in message &&
    (message.role === 'user' || message.role === 'assistant')
  );
}

function normalizeRole(message: UserMessage | AssistantMessage): RuntimeMessage['role'] {
  return message.role === 'assistant' ? 'assistant' : 'user';
}

function toRuntimeMessage(message: AgentMessage): RuntimeMessage | undefined {
  if (!isSupportedMessage(message)) {
    return undefined;
  }
  if (message.role === 'user') {
    return {
      role: 'user',
      content: typeof message.content === 'string' ? message.content : contentText(message.content),
      timestamp: message.timestamp,
    };
  }

  return {
    role: 'assistant',
    content: contentText(message.content),
    parts: message.content.flatMap((part) =>
      part.type === 'toolCall'
        ? [
            {
              type: 'tool_call' as const,
              id: part.id,
              name: part.name,
              arguments: part.arguments as Readonly<Record<string, unknown>>,
            },
          ]
        : [],
    ),
    provider: message.provider,
    model: message.model,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    stopReason: normalizeStopReason(message.stopReason),
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    usage: normalizeUsage(message),
    timestamp: message.timestamp,
  };
}

function normalizeUsage(message: AssistantMessage): RuntimeUsage {
  return {
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    totalTokens: message.usage.totalTokens,
    costUsd: message.usage.cost.total,
  };
}

function normalizeStopReason(
  stopReason: AssistantMessage['stopReason'],
): RuntimeAssistantMessage['stopReason'] {
  return stopReason === 'toolUse' ? 'tool_use' : stopReason;
}

function toPiMessage(message: RuntimeMessage): Message {
  if (message.role === 'user') {
    return message;
  }

  return {
    role: 'assistant',
    content: [{ type: 'text', text: message.content }],
    api: 'openai-completions',
    provider: message.provider,
    model: message.model,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    usage: {
      input: message.usage.inputTokens,
      output: message.usage.outputTokens,
      cacheRead: message.usage.cacheReadTokens,
      cacheWrite: message.usage.cacheWriteTokens,
      totalTokens: message.usage.totalTokens,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: message.usage.costUsd,
      },
    },
    stopReason: message.stopReason === 'tool_use' ? 'toolUse' : message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp,
  };
}

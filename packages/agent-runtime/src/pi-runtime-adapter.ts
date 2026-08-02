import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
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
  type ToolResultMessage,
  type Usage,
  type UserMessage,
} from '@earendil-works/pi-ai';

import { createArkBackend, type ArkRuntimeConfig } from './ark-provider.js';
import {
  createOpenAICompatibleBackend,
  type OpenAICompatibleRuntimeConfig,
} from './openai-compatible-provider.js';
import type {
  AgentRuntime,
  RuntimeAssistantContentBlock,
  RuntimeAssistantMessage,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeFailure,
  RuntimeMessage,
  RuntimeRequest,
  RuntimeResult,
  RuntimeTool,
  RuntimeToolResultMessage,
  RuntimeTranscriptMessage,
  RuntimeUserMessage,
  RuntimeUsage,
} from './contracts.js';
import { convertAgentPressMessages } from './current-turn.js';

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
  private activeAgent: Agent | undefined;

  private constructor(private readonly backend: PiBackend) {}

  public static forArk(config: ArkRuntimeConfig): PiRuntimeAdapter {
    return new PiRuntimeAdapter(createArkBackend(config));
  }

  public static forOpenAICompatible(config: OpenAICompatibleRuntimeConfig): PiRuntimeAdapter {
    return new PiRuntimeAdapter(createOpenAICompatibleBackend(config));
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
    const stableMessages: RuntimeMessage[] = request.history.filter(
      (message): message is RuntimeMessage => message.role !== 'tool',
    );
    const terminatingTools = new Set(
      request.tools?.filter(({ terminateOnSuccess }) => terminateOnSuccess).map(({ name }) => name),
    );
    const blockedByToolLimit = new Map<string, boolean>();
    let domainToolCalls = 0;
    let blockedToolCalls = 0;
    let failedCompletionCalls = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt,
        model: this.backend.model,
        messages: request.history.map(toPiMessage),
        tools: request.tools?.map((tool) => toPiTool(tool, request.runId)) ?? [],
        thinkingLevel: 'off',
      },
      streamFn: this.backend.models.streamSimple.bind(this.backend.models),
      convertToLlm: convertAgentPressMessages,
      sessionId: request.runId,
      maxRetryDelayMs: 10_000,
      ...(request.beforeToolCall || request.maxToolCalls !== undefined
        ? {
            beforeToolCall: async ({ toolCall, args }) => {
              const policy = await request.beforeToolCall?.({
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                arguments: args,
              });
              if (policy?.block) return policy;
              if (terminatingTools.has(toolCall.name)) return policy;
              if (request.maxToolCalls !== undefined && domainToolCalls >= request.maxToolCalls) {
                blockedToolCalls += 1;
                blockedByToolLimit.set(toolCall.id, blockedToolCalls > 1);
                return {
                  block: true,
                  reason: `Tool call limit reached (${String(request.maxToolCalls)}). Submit the protocol completion tool now.`,
                };
              }
              domainToolCalls += 1;
              return policy;
            },
          }
        : {}),
      ...(request.afterToolCall || request.maxToolCalls !== undefined
        ? {
            afterToolCall: async ({ toolCall, args, result, isError }) => {
              const normalized = toRuntimeToolResult(toolCall.id, toolCall.name, result, isError);
              const update = await request.afterToolCall?.({
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                arguments: args,
                result: normalized,
              });
              const terminateForLimit = blockedByToolLimit.get(toolCall.id);
              blockedByToolLimit.delete(toolCall.id);
              const terminate = terminateForLimit ? true : update?.terminate;
              return update || terminate
                ? {
                    ...(update?.content === undefined
                      ? {}
                      : { content: [{ type: 'text' as const, text: update.content }] }),
                    ...(update?.details === undefined ? {} : { details: update.details }),
                    ...(update?.isError === undefined ? {} : { isError: update.isError }),
                    ...(update?.usage === undefined ? {} : { usage: toPiUsage(update.usage) }),
                    ...(terminate === undefined ? {} : { terminate }),
                    ...(update?.addedToolNames === undefined
                      ? {}
                      : { addedToolNames: [...update.addedToolNames] }),
                  }
                : undefined;
            },
          }
        : {}),
    });
    this.activeAgent = agent;
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
        if (
          runtimeEvent.type === 'tool.completed' &&
          runtimeEvent.result.isError &&
          terminatingTools.has(runtimeEvent.result.toolName) &&
          request.maxFailedCompletionCalls !== undefined &&
          ++failedCompletionCalls >= request.maxFailedCompletionCalls
        ) {
          state.failure = {
            code: 'protocol_error',
            message: `Completion tool failed validation ${String(failedCompletionCalls)} times`,
            retryable: true,
          };
          agent.abort();
        }
        await sink(runtimeEvent);
      }
    });

    try {
      if (state.isCancelled()) {
        await sink({ type: 'run.cancelled' });
        return { status: 'cancelled', messages: stableMessages };
      }

      if (request.continuation) {
        await agent.continue();
      } else {
        await agent.prompt(request.currentTurn);
      }

      if (state.failure) {
        await sink({ type: 'run.failed', error: state.failure });
        return { status: 'failed', messages: stableMessages, error: state.failure };
      }
      if (state.isCancelled()) {
        await sink({ type: 'run.cancelled' });
        return { status: 'cancelled', messages: stableMessages };
      }

      await sink({ type: 'run.completed', messages: stableMessages });
      return { status: 'completed', messages: stableMessages };
    } catch (error) {
      const runtimeFailure: RuntimeFailure = {
        code: 'runtime_error',
        message: error instanceof Error ? error.message : 'Unknown Pi runtime error',
        retryable: !state.isCancelled(),
      };
      if (state.failure) {
        await sink({ type: 'run.failed', error: state.failure });
        return { status: 'failed', messages: stableMessages, error: state.failure };
      }
      if (state.isCancelled()) {
        await sink({ type: 'run.cancelled' });
        return { status: 'cancelled', messages: stableMessages };
      }
      await sink({ type: 'run.failed', error: runtimeFailure });
      return { status: 'failed', messages: stableMessages, error: runtimeFailure };
    } finally {
      if (this.activeAgent === agent) this.activeAgent = undefined;
      signal?.removeEventListener('abort', abort);
      unsubscribe();
    }
  }

  public steer(message: RuntimeUserMessage): boolean {
    const agent = this.activeAgent;
    if (!agent?.state.isStreaming) return false;
    agent.steer(toPiMessage(message));
    return true;
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
        ...(onUpdate
          ? {
              onUpdate: (details: unknown) => {
                onUpdate({
                  content: [{ type: 'text', text: serializeToolOutput(details) }],
                  details,
                });
              },
            }
          : {}),
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
      const toolResult = toRuntimeToolResult(
        event.toolCallId,
        event.toolName,
        event.result as AgentToolResult<unknown>,
        event.isError,
      );
      return [{ type: 'tool.completed', result: toolResult }];
    }
    case 'agent_end':
    case 'turn_end':
      return [];
  }
}

function toRuntimeToolResult(
  toolCallId: string,
  toolName: string,
  result: AgentToolResult<unknown>,
  isError: boolean,
): RuntimeToolResultMessage {
  return {
    role: 'tool',
    toolCallId,
    toolName,
    content: result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
    ...(result.details === undefined ? {} : { details: result.details }),
    ...(result.usage === undefined ? {} : { usage: normalizePiUsage(result.usage) }),
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
    ...(result.addedToolNames === undefined ? {} : { addedToolNames: [...result.addedToolNames] }),
    isError,
    timestamp: Date.now(),
  };
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
    blocks: message.content.map((part): RuntimeAssistantContentBlock => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'thinking') return { type: 'thinking', thinking: part.thinking };
      return {
        type: 'tool_call',
        id: part.id,
        name: part.name,
        arguments: part.arguments as Readonly<Record<string, unknown>>,
      };
    }),
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
  return normalizePiUsage(message.usage);
}

function normalizePiUsage(usage: Usage): RuntimeUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    costUsd: usage.cost.total,
  };
}

function toPiUsage(usage: RuntimeUsage): Usage {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage.costUsd,
    },
  };
}

function normalizeStopReason(
  stopReason: AssistantMessage['stopReason'],
): RuntimeAssistantMessage['stopReason'] {
  return stopReason === 'toolUse' ? 'tool_use' : stopReason;
}

function toPiMessage(message: RuntimeTranscriptMessage): Message {
  if (message.role === 'user') {
    return message;
  }

  if (message.role === 'tool') {
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: [{ type: 'text', text: message.content }],
      ...(message.details === undefined ? {} : { details: message.details }),
      ...(message.usage === undefined ? {} : { usage: toPiUsage(message.usage) }),
      ...(message.addedToolNames === undefined
        ? {}
        : { addedToolNames: [...message.addedToolNames] }),
      isError: message.isError,
      timestamp: message.timestamp,
    };
    return toolResult;
  }

  return {
    role: 'assistant',
    content: message.blocks?.map((block) => {
      if (block.type === 'text') return { type: 'text' as const, text: block.text };
      if (block.type === 'thinking') return { type: 'thinking' as const, thinking: block.thinking };
      return {
        type: 'toolCall' as const,
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      };
    }) ?? [
      { type: 'text' as const, text: message.content },
      ...(message.parts ?? []).map((part) => ({
        type: 'toolCall' as const,
        id: part.id,
        name: part.name,
        arguments: part.arguments,
      })),
    ],
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

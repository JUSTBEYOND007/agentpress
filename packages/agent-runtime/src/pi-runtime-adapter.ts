import {
  Agent,
  shouldCompact,
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
  isContextOverflow,
  type Api,
  type AssistantMessage,
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
  RuntimeContextCompactionMessage,
  RuntimeContextCompactionResult,
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
import {
  convertAgentPressMessages,
  createRuntimeCompactionSummary,
  isRuntimeCompactionSummary,
  isRuntimeCurrentTurn,
} from './current-turn.js';
import { adaptProviderSchema, providerFromId } from './schema-compatibility.js';
import { ToolLoopGuard } from './tool-loop-guard.js';

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

  public clearFailure(): void {
    delete this.failure;
  }
}

export type FauxRuntimeConfig = {
  readonly responses: readonly (string | AssistantMessage)[];
  readonly tokensPerSecond?: number;
  readonly onStreamOptions?: (options: Readonly<Record<string, unknown>>) => void;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
};

export class PiRuntimeAdapter implements AgentRuntime {
  private activeAgent: Agent | undefined;

  public readonly identity: {
    readonly provider: string;
    readonly model: string;
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
  };

  private constructor(
    private readonly backend: PiBackend,
    private readonly onStreamOptions?: (options: Readonly<Record<string, unknown>>) => void,
  ) {
    this.identity = {
      provider: backend.model.provider,
      model: backend.model.id,
      contextWindow: backend.model.contextWindow,
      maxOutputTokens: backend.model.maxTokens,
    };
  }

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

    const fauxModel = faux.getModel();
    return new PiRuntimeAdapter(
      {
        models,
        model: {
          ...fauxModel,
          contextWindow: config.contextWindow ?? fauxModel.contextWindow,
          maxTokens: config.maxOutputTokens ?? fauxModel.maxTokens,
        },
      },
      config.onStreamOptions,
    );
  }

  public async execute(
    request: RuntimeRequest,
    sink: RuntimeEventSink,
    signal?: AbortSignal,
  ): Promise<RuntimeResult> {
    const historyFailure = validateRuntimeHistory(request.history);
    if (historyFailure) {
      await sink({ type: 'run.failed', error: historyFailure });
      return { status: 'failed', messages: [], error: historyFailure };
    }
    const budget = this.identity.contextWindow - this.identity.maxOutputTokens;
    const compactContext = async (
      input: Parameters<NonNullable<RuntimeRequest['compactContext']>>[0],
    ): Promise<RuntimeContextCompactionResult> => {
      try {
        return request.compactContext
          ? await request.compactContext(input)
          : { status: 'not_needed' };
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Runtime context compaction failed',
        };
      }
    };
    let initialHistory = [...request.history];
    const estimatedInput = estimateRequestTokens({ ...request, history: initialHistory });
    if (estimatedInput > budget && request.compactContext) {
      const compacted = await compactContext({
        runId: request.runId,
        reason: 'overflow',
        contextWindow: this.identity.contextWindow,
        reserveTokens: this.identity.maxOutputTokens,
        messages: initialHistory.map(toCompactionSnapshot),
        ...(signal ? { signal } : {}),
      });
      if (compacted.status === 'completed') {
        initialHistory = applyCompactionResult(initialHistory, compacted);
      }
    }
    const effectiveRequest = { ...request, history: initialHistory };
    const effectiveEstimatedInput = estimateRequestTokens(effectiveRequest);
    if (effectiveEstimatedInput > budget) {
      const error: RuntimeFailure = {
        code: 'invalid_history',
        message: `Model input budget exceeded (${String(effectiveEstimatedInput)} > ${String(budget)} tokens)`,
        retryable: false,
      };
      await sink({ type: 'run.failed', error });
      return { status: 'failed', messages: [], error };
    }
    const stableMessages: RuntimeMessage[] = initialHistory.filter(
      (message): message is RuntimeMessage =>
        'role' in message && (message.role === 'user' || message.role === 'assistant'),
    );
    const terminatingTools = new Set(
      request.tools?.filter(({ terminateOnSuccess }) => terminateOnSuccess).map(({ name }) => name),
    );
    const blockedByToolLimit = new Map<string, boolean>();
    const blockedByLoopGuard = new Map<string, boolean>();
    const toolLoopGuard = new ToolLoopGuard(
      request.toolLoopGuard?.maxConsecutiveIdenticalCalls ?? 3,
    );
    let domainToolCalls = 0;
    let blockedToolCalls = 0;
    let failedCompletionCalls = 0;
    let providerToolCallsObserved = 0;
    let overflowMessage: AssistantMessage | undefined;
    let overflowRecoveryAttempts = 0;
    const state = new ExecutionState(signal?.aborted ?? false);
    let toolChoiceServed = false;
    const streamFn = (
      model: Model<Api>,
      context: Parameters<Models['streamSimple']>[1],
      options?: Parameters<Models['streamSimple']>[2],
    ) => {
      const toolChoice = !toolChoiceServed ? request.toolChoice : undefined;
      toolChoiceServed = true;
      const streamOptions = {
        ...options,
        ...(toolChoice === undefined ? {} : { toolChoice }),
      };
      this.onStreamOptions?.(streamOptions);
      return this.backend.models.streamSimple(model, context, streamOptions);
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt,
        model: this.backend.model,
        messages: initialHistory.map(toPiMessage),
        tools:
          request.tools?.map((tool) =>
            toPiTool(tool, request.runId, providerFromId(this.backend.model.provider)),
          ) ?? [],
        thinkingLevel: 'off',
      },
      streamFn,
      convertToLlm: convertAgentPressMessages,
      sessionId: request.runId,
      maxRetryDelayMs: 10_000,
      ...(request.beforeToolCall ||
      request.maxToolCalls !== undefined ||
      request.toolLoopGuard !== undefined
        ? {
            beforeToolCall: async ({ toolCall, args }) => {
              const policy = await request.beforeToolCall?.({
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                arguments: args,
              });
              if (policy?.block) return policy;
              if (terminatingTools.has(toolCall.name)) return policy;
              const loopDecision = toolLoopGuard.observe(
                toolCall.name,
                args as Readonly<Record<string, unknown>>,
              );
              if (!loopDecision.allow) {
                blockedByLoopGuard.set(toolCall.id, true);
                state.failure = {
                  code: 'protocol_error',
                  message: loopDecision.reason,
                  retryable: true,
                };
                agent.abort();
                return { block: true, reason: loopDecision.reason };
              }
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
              const terminateForLoop = blockedByLoopGuard.get(toolCall.id);
              blockedByLoopGuard.delete(toolCall.id);
              const terminate = terminateForLimit || terminateForLoop ? true : update?.terminate;
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
      ...(request.compactContext
        ? {
            prepareNextTurnWithContext: async ({ context, toolResults }) => {
              if (toolResults.length === 0) return undefined;
              const estimated = estimateAgentMessagesTokens(context.messages);
              if (
                !shouldCompact(estimated, this.identity.contextWindow, {
                  enabled: true,
                  reserveTokens: this.identity.maxOutputTokens,
                  keepRecentTokens: 1,
                })
              ) {
                return undefined;
              }
              const compacted = await compactContext({
                runId: request.runId,
                reason: 'mid_turn',
                contextWindow: this.identity.contextWindow,
                reserveTokens: this.identity.maxOutputTokens,
                messages: context.messages.map(toCompactionSnapshot),
                ...(signal ? { signal } : {}),
              });
              if (compacted.status !== 'completed') return undefined;
              const replacement = applyCompactionResult(context.messages, compacted);
              if (estimateAgentMessagesTokens(replacement) >= estimated) return undefined;
              return { context: { ...context, messages: replacement } };
            },
          }
        : {}),
    });
    this.activeAgent = agent;
    const abort = (): void => {
      state.cancel();
      agent.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });

    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === 'tool_execution_start') providerToolCallsObserved += 1;
      if (
        event.type === 'message_end' &&
        isPiAssistantMessage(event.message) &&
        isContextOverflow(event.message, this.identity.contextWindow)
      ) {
        overflowMessage = event.message;
      }
      const normalized = normalizeEvent(event);
      for (const runtimeEvent of normalized) {
        if (runtimeEvent.type === 'message.completed') {
          if (runtimeEvent.message.role === 'assistant') {
            stableMessages.push(runtimeEvent.message);
            if (runtimeEvent.message.stopReason === 'error' && !state.failure && !overflowMessage) {
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

      if (overflowMessage && request.compactContext && overflowRecoveryAttempts === 0) {
        overflowRecoveryAttempts += 1;
        const failedMessage = overflowMessage;
        const activeMessages = agent.state.messages.filter((message) => message !== failedMessage);
        const estimated = estimateAgentMessagesTokens(activeMessages);
        const compacted = await compactContext({
          runId: request.runId,
          reason: 'overflow',
          contextWindow: this.identity.contextWindow,
          reserveTokens: this.identity.maxOutputTokens,
          messages: activeMessages.map(toCompactionSnapshot),
          ...(signal ? { signal } : {}),
        });
        if (compacted.status === 'completed') {
          const replacement = applyCompactionResult(activeMessages, compacted);
          if (estimateAgentMessagesTokens(replacement) < estimated) {
            agent.state.messages = replacement;
            const failedRuntime = toRuntimeMessage(failedMessage);
            if (failedRuntime?.role === 'assistant') {
              const failedIndex = stableMessages.findLastIndex(
                (message) =>
                  message.role === 'assistant' &&
                  message.timestamp === failedRuntime.timestamp &&
                  message.provider === failedRuntime.provider &&
                  message.model === failedRuntime.model,
              );
              if (failedIndex >= 0) stableMessages.splice(failedIndex, 1);
            }
            overflowMessage = undefined;
            state.clearFailure();
            if (providerToolCallsObserved === 0) toolChoiceServed = false;
            await agent.continue();
          }
        }
      }

      if (overflowMessage && !state.failure) {
        state.failure = {
          code: 'provider_error',
          message: overflowMessage.errorMessage ?? 'Provider context window overflow',
          retryable: true,
        };
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

/**
 * Validate the durable transcript before handing it to Pi. Pi itself produces
 * a ToolResult for every live call, but a crashed writer or a malformed
 * provider replay can leave a persisted assistant ToolCall unmatched. Sending
 * that history back to a provider is not recoverable by prompt text, so fail
 * closed with a deterministic protocol error.
 */
export function validateRuntimeHistory(
  history: readonly RuntimeTranscriptMessage[],
): RuntimeFailure | undefined {
  const pending = new Map<string, string>();
  const seenResults = new Set<string>();
  for (const [index, message] of history.entries()) {
    if (isRuntimeCompactionSummary(message)) continue;
    if (message.role === 'assistant') {
      for (const block of message.blocks ?? []) {
        if (block.type !== 'tool_call') continue;
        if (!isPlainRecord(block.arguments)) {
          return invalidHistory(
            `ToolCall ${block.id} has non-object or partial arguments at ${String(index)}`,
          );
        }
        if (pending.has(block.id) || seenResults.has(block.id)) {
          return invalidHistory(`ToolCall ${block.id} is duplicated in persisted history`);
        }
        pending.set(block.id, block.name);
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    if (seenResults.has(message.toolCallId)) {
      return invalidHistory(`ToolResult ${message.toolCallId} is duplicated in persisted history`);
    }
    const expectedName = pending.get(message.toolCallId);
    if (!expectedName) {
      return invalidHistory(`ToolResult ${message.toolCallId} has no persisted ToolCall`);
    }
    if (expectedName !== message.toolName) {
      return invalidHistory(
        `ToolResult ${message.toolCallId} names ${message.toolName}, expected ${expectedName}`,
      );
    }
    pending.delete(message.toolCallId);
    seenResults.add(message.toolCallId);
  }
  if (pending.size > 0) {
    const [toolCallId] = pending.keys();
    return invalidHistory(`ToolCall ${toolCallId ?? 'unknown'} has no persisted ToolResult`);
  }
  return undefined;
}

function invalidHistory(message: string): RuntimeFailure {
  return { code: 'invalid_history', message, retryable: false };
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function estimateRequestTokens(request: RuntimeRequest): number {
  const serialized = JSON.stringify({
    systemPrompt: request.systemPrompt,
    history: request.history,
    currentTurn: request.currentTurn,
    tools: request.tools?.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
  });
  return Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4);
}

function estimateAgentMessagesTokens(messages: readonly AgentMessage[]): number {
  return estimateSerializedTokens(messages);
}

function estimateSerializedTokens(value: unknown): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4));
}

function toCompactionSnapshot(
  message: RuntimeTranscriptMessage | AgentMessage,
  index: number,
): RuntimeContextCompactionMessage {
  if (isRuntimeCompactionSummary(message)) {
    return {
      index,
      role: 'summary',
      content: message.summary,
      tokenCount: estimateSerializedTokens(message),
    };
  }
  if (isRuntimeCurrentTurn(message)) {
    return {
      index,
      role: 'application',
      content: JSON.stringify(message),
      tokenCount: estimateSerializedTokens(message),
    };
  }
  if ('role' in message && message.role === 'user') {
    const content =
      typeof message.content === 'string' ? message.content : contentText(message.content);
    return { index, role: 'user', content, tokenCount: estimateSerializedTokens(message) };
  }
  if ('role' in message && message.role === 'assistant') {
    const runtimeBlocks = 'blocks' in message ? message.blocks : undefined;
    const toolCallIds = runtimeBlocks
      ? runtimeBlocks.flatMap((part) => (part.type === 'tool_call' ? [part.id] : []))
      : Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === 'toolCall' ? [part.id] : []))
        : [];
    const content =
      typeof message.content === 'string' ? message.content : contentText(message.content);
    return {
      index,
      role: 'assistant',
      content,
      tokenCount: estimateSerializedTokens(message),
      ...(toolCallIds.length > 0 ? { toolCallIds } : {}),
    };
  }
  if ('role' in message && (message.role === 'tool' || message.role === 'toolResult')) {
    const content =
      typeof message.content === 'string' ? message.content : contentText(message.content);
    return {
      index,
      role: 'tool',
      content,
      tokenCount: estimateSerializedTokens(message),
      toolCallId: message.toolCallId,
    };
  }
  return {
    index,
    role: 'application',
    content: JSON.stringify(message),
    tokenCount: estimateSerializedTokens(message),
  };
}

function applyCompactionResult(
  messages: readonly RuntimeTranscriptMessage[],
  result: Extract<RuntimeContextCompactionResult, { readonly status: 'completed' }>,
): RuntimeTranscriptMessage[];
function applyCompactionResult(
  messages: readonly AgentMessage[],
  result: Extract<RuntimeContextCompactionResult, { readonly status: 'completed' }>,
): AgentMessage[];
function applyCompactionResult(
  messages: readonly (RuntimeTranscriptMessage | AgentMessage)[],
  result: Extract<RuntimeContextCompactionResult, { readonly status: 'completed' }>,
): (RuntimeTranscriptMessage | AgentMessage)[] {
  if (
    !Number.isSafeInteger(result.firstKeptMessageIndex) ||
    result.firstKeptMessageIndex < 1 ||
    result.firstKeptMessageIndex >= messages.length
  ) {
    return [...messages];
  }
  return [createRuntimeCompactionSummary(result), ...messages.slice(result.firstKeptMessageIndex)];
}

function toPiTool(
  tool: RuntimeTool,
  runId: string,
  provider: ReturnType<typeof providerFromId>,
): AgentTool {
  const adaptation = adaptProviderSchema(tool.parameters, {
    provider,
    strict: tool.constrainedSampling !== false && tool.constrainedSampling?.strict === 'require',
  });
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: adaptation.schema,
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

function isPiAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return typeof message === 'object' && 'role' in message && message.role === 'assistant';
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

function toPiMessage(message: RuntimeTranscriptMessage): AgentMessage {
  if (isRuntimeCompactionSummary(message)) return message;
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

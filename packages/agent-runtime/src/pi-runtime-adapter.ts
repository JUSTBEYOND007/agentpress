import { Agent, shouldCompact } from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  isContextOverflow,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';

import { createArkBackend, type ArkRuntimeConfig } from './ark-provider.js';
import {
  createOpenAICompatibleBackend,
  type OpenAICompatibleRuntimeConfig,
} from './openai-compatible-provider.js';
import type {
  AgentRuntime,
  RuntimeContextCompactionResult,
  RuntimeEventSink,
  RuntimeFailure,
  RuntimeMessage,
  RuntimeRequest,
  RuntimeResult,
  RuntimeUserMessage,
} from './contracts.js';
import { convertAgentPressMessages } from './current-turn.js';
import { providerFromId } from './schema-compatibility.js';
import { ToolLoopGuard } from './tool-loop-guard.js';
import {
  applyCompactionResult,
  estimateAgentMessagesTokens,
  estimateRequestTokens,
  isPiAssistantMessage,
  normalizeEvent,
  toCompactionSnapshot,
  toPiMessage,
  toPiTool,
  toPiUsage,
  toRuntimeMessage,
  toRuntimeToolResult,
  validateRuntimeHistory,
} from './pi-runtime-transforms.js';

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

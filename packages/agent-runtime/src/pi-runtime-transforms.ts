import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from '@earendil-works/pi-agent-core';
import {
  contentText,
  type AssistantMessage,
  type ToolResultMessage,
  type Usage,
  type UserMessage,
} from '@earendil-works/pi-ai';

import {
  createRuntimeCompactionSummary,
  isRuntimeCompactionSummary,
  isRuntimeCurrentTurn,
} from './current-turn.js';
import {
  createProviderToolSchemaCodec,
  type ProviderToolSchemaCapability,
} from './provider-tool-schema-codec.js';
import type {
  RuntimeAssistantContentBlock,
  RuntimeAssistantMessage,
  RuntimeContextCompactionMessage,
  RuntimeContextCompactionResult,
  RuntimeFailure,
  RuntimeMessage,
  RuntimeRequest,
  RuntimeEvent,
  RuntimeTool,
  RuntimeToolResultMessage,
  RuntimeTranscriptMessage,
  RuntimeUsage,
} from './contracts.js';

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

export function estimateRequestTokens(request: RuntimeRequest): number {
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

export function estimateAgentMessagesTokens(messages: readonly AgentMessage[]): number {
  return estimateSerializedTokens(messages);
}

function estimateSerializedTokens(value: unknown): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4));
}

export function toCompactionSnapshot(
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

export function applyCompactionResult(
  messages: readonly RuntimeTranscriptMessage[],
  result: Extract<RuntimeContextCompactionResult, { readonly status: 'completed' }>,
): RuntimeTranscriptMessage[];
export function applyCompactionResult(
  messages: readonly AgentMessage[],
  result: Extract<RuntimeContextCompactionResult, { readonly status: 'completed' }>,
): AgentMessage[];
export function applyCompactionResult(
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

export function toPiTool(
  tool: RuntimeTool,
  runId: string,
  capability: ProviderToolSchemaCapability,
): AgentTool {
  const codec = createProviderToolSchemaCodec(
    tool.parameters,
    capability,
    tool.constrainedSampling === false ? false : (tool.constrainedSampling?.strict ?? false),
  );
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: codec.wireSchema,
    prepareArguments: codec.prepareArguments,
    ...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    execute: async (providerToolCallId, parameters, signal, onUpdate) => {
      const output = await tool.execute(codec.decodeArguments(parameters), {
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

export function normalizeEvent(event: AgentEvent): readonly RuntimeEvent[] {
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

export function toRuntimeToolResult(
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

export function isPiAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return typeof message === 'object' && 'role' in message && message.role === 'assistant';
}

function normalizeRole(message: UserMessage | AssistantMessage): RuntimeMessage['role'] {
  return message.role === 'assistant' ? 'assistant' : 'user';
}

export function toRuntimeMessage(message: AgentMessage): RuntimeMessage | undefined {
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

export function toPiUsage(usage: RuntimeUsage): Usage {
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

export function toPiMessage(message: RuntimeTranscriptMessage): AgentMessage {
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

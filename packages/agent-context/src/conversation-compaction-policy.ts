import { shouldCompact as shouldPiCompact } from '@earendil-works/pi-agent-core';

export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

export type CompactionBudget = {
  readonly reserveTokens: number;
  readonly provenance: 'default' | 'explicit' | 'proportional';
};

export type CompactionPolicyMessage = {
  readonly sequence: number;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly tokenCount: number;
};

export type ConversationCompactionPlan = {
  readonly sourceFromSequence: number;
  readonly sourceThroughSequence: number;
  readonly firstKeptMessageSequence: number;
  readonly tokensBefore: number;
  readonly keptTokens: number;
};

export type RuntimeCompactionPolicyMessage = {
  readonly index: number;
  readonly role: 'user' | 'assistant' | 'tool' | 'application' | 'summary';
  readonly tokenCount: number;
  readonly toolCallIds?: readonly string[];
  readonly toolCallId?: string;
};

export type RuntimeCompactionPlan = {
  readonly sourceFromIndex: number;
  readonly sourceThroughIndex: number;
  readonly firstKeptMessageIndex: number;
  readonly tokensBefore: number;
  readonly keptTokens: number;
};

export function resolveCompactionBudget(
  contextWindow: number,
  explicitReserveTokens?: number,
): CompactionBudget {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 1) {
    throw new Error('Compaction context window must be an integer greater than one');
  }
  if (
    explicitReserveTokens !== undefined &&
    (!Number.isSafeInteger(explicitReserveTokens) || explicitReserveTokens < 0)
  ) {
    throw new Error('Explicit compaction reserve must be a non-negative integer');
  }
  const proportional = Math.max(1, Math.floor(contextWindow * 0.15));
  const requested = explicitReserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS;
  const effective = Math.max(proportional, requested);
  if (
    effective >= contextWindow ||
    (explicitReserveTokens === undefined && effective >= contextWindow - proportional)
  ) {
    return { reserveTokens: proportional, provenance: 'proportional' };
  }
  return {
    reserveTokens: effective,
    provenance: explicitReserveTokens === undefined ? 'default' : 'explicit',
  };
}

export function shouldCompactConversation(
  contextTokens: number,
  contextWindow: number,
  budget: CompactionBudget,
): boolean {
  if (!Number.isFinite(contextTokens) || contextTokens < 0) {
    throw new Error('Compaction context tokens must be non-negative');
  }
  return shouldPiCompact(contextTokens, contextWindow, {
    enabled: true,
    reserveTokens: budget.reserveTokens,
    keepRecentTokens: 1,
  });
}

export function resolveCompactionKeepTokens(
  contextWindow: number,
  budget: CompactionBudget,
  requestedKeepTokens = 20_000,
): number {
  if (!Number.isSafeInteger(requestedKeepTokens) || requestedKeepTokens < 1) {
    throw new Error('Compaction keep budget must be a positive integer');
  }
  const usableTokens = Math.max(1, contextWindow - budget.reserveTokens);
  return Math.max(1, Math.min(requestedKeepTokens, Math.floor(usableTokens / 2)));
}

export function planConversationCompaction(input: {
  readonly messages: readonly CompactionPolicyMessage[];
  readonly sourceFromSequence: number;
  readonly keepRecentTokens: number;
}): ConversationCompactionPlan | undefined {
  if (!Number.isSafeInteger(input.sourceFromSequence) || input.sourceFromSequence < 1) {
    throw new Error('Compaction source sequence must be a positive integer');
  }
  if (!Number.isSafeInteger(input.keepRecentTokens) || input.keepRecentTokens < 1) {
    throw new Error('Compaction keep budget must be a positive integer');
  }
  const messages = input.messages.filter(({ sequence }) => sequence >= input.sourceFromSequence);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const previous = messages[index - 1];
    if (
      !message ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence < input.sourceFromSequence ||
      !Number.isSafeInteger(message.tokenCount) ||
      message.tokenCount < 0 ||
      (previous && message.sequence <= previous.sequence)
    ) {
      throw new Error('Compaction messages must be ordered with valid token counts');
    }
  }
  if (messages.length < 3) return undefined;

  let keptTokens = 0;
  let boundaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    keptTokens += message.tokenCount;
    if (message.role === 'user' && keptTokens >= input.keepRecentTokens) {
      boundaryIndex = index;
      break;
    }
  }
  if (boundaryIndex <= 0) return undefined;
  const boundary = messages[boundaryIndex];
  const summarizedThrough = messages[boundaryIndex - 1];
  if (!boundary || !summarizedThrough) return undefined;

  return {
    sourceFromSequence: input.sourceFromSequence,
    sourceThroughSequence: summarizedThrough.sequence,
    firstKeptMessageSequence: boundary.sequence,
    tokensBefore: messages.reduce((total, message) => total + message.tokenCount, 0),
    keptTokens,
  };
}

export function planRuntimeCompaction(input: {
  readonly messages: readonly RuntimeCompactionPolicyMessage[];
  readonly keepRecentTokens: number;
}): RuntimeCompactionPlan | undefined {
  if (!Number.isSafeInteger(input.keepRecentTokens) || input.keepRecentTokens < 1) {
    throw new Error('Runtime compaction keep budget must be a positive integer');
  }
  validateRuntimeCompactionMessages(input.messages);
  if (input.messages.length < 3) return undefined;

  let keptTokens = 0;
  for (let position = input.messages.length - 1; position > 0; position -= 1) {
    const message = input.messages[position];
    if (!message) continue;
    keptTokens += message.tokenCount;
    if (keptTokens < input.keepRecentTokens || !isRuntimeKeepBoundary(message)) continue;
    const previous = input.messages[position - 1];
    if (!previous) continue;
    return {
      sourceFromIndex: input.messages[0]?.index ?? 0,
      sourceThroughIndex: previous.index,
      firstKeptMessageIndex: message.index,
      tokensBefore: input.messages.reduce((total, item) => total + item.tokenCount, 0),
      keptTokens,
    };
  }
  return undefined;
}

function validateRuntimeCompactionMessages(
  messages: readonly RuntimeCompactionPolicyMessage[],
): void {
  const pending = new Set<string>();
  const settled = new Set<string>();
  for (const [position, message] of messages.entries()) {
    const previous = messages[position - 1];
    if (
      !Number.isSafeInteger(message.index) ||
      message.index < 0 ||
      (previous && message.index <= previous.index) ||
      !Number.isSafeInteger(message.tokenCount) ||
      message.tokenCount < 0
    ) {
      throw new Error('Runtime compaction messages must be ordered with valid token counts');
    }
    if (message.role === 'assistant') {
      for (const id of message.toolCallIds ?? []) {
        if (!id || pending.has(id) || settled.has(id)) {
          throw new Error('Runtime compaction ToolCalls must have unique non-empty ids');
        }
        pending.add(id);
      }
    }
    if (message.role === 'tool') {
      if (!message.toolCallId || !pending.delete(message.toolCallId)) {
        throw new Error('Runtime compaction ToolResult must match a preceding ToolCall');
      }
      settled.add(message.toolCallId);
    }
  }
  if (pending.size > 0) {
    throw new Error('Runtime compaction cannot summarize an unresolved ToolCall');
  }
}

function isRuntimeKeepBoundary(message: RuntimeCompactionPolicyMessage): boolean {
  return (
    message.role === 'user' ||
    message.role === 'application' ||
    message.role === 'summary' ||
    (message.role === 'assistant' && (message.toolCallIds?.length ?? 0) > 0)
  );
}

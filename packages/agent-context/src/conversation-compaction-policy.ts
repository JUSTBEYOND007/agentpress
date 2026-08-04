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
  return contextTokens > Math.max(0, contextWindow - budget.reserveTokens);
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

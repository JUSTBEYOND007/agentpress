import type { ActionEnvelopeV1 } from '@agentpress/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message, UserMessage } from '@earendil-works/pi-ai';
import type { RuntimeCompactionSummary, RuntimeContextCompactionResult } from './contracts.js';

export const RUNTIME_CURRENT_TURN_VERSION = 1 as const;

export type RuntimeContextPack = {
  readonly content: string;
  readonly contentHash: string;
  readonly format: string;
  readonly schemaVersion: number;
  readonly manifest: Readonly<Record<string, unknown>>;
};

export type RuntimeCurrentTurn = {
  readonly type: 'agentpress_current_turn';
  readonly version: typeof RUNTIME_CURRENT_TURN_VERSION;
  readonly source: 'user' | 'application' | 'recovery';
  readonly request: string;
  readonly actionEnvelope: ActionEnvelopeV1;
  readonly context?: RuntimeContextPack;
  readonly timestamp: number;
};

declare module '@earendil-works/pi-agent-core' {
  // Declaration merging is the extension point provided by pi-agent-core.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface CustomAgentMessages {
    agentpressCurrentTurn: RuntimeCurrentTurn;
    agentpressCompactionSummary: RuntimeCompactionSummary;
  }
}

export function convertAgentPressMessages(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message) => {
    if (isRuntimeCompactionSummary(message)) {
      const converted: UserMessage = {
        role: 'user',
        content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${message.summary}\n</summary>`,
        timestamp: message.timestamp,
      };
      return [converted];
    }
    if (!isRuntimeCurrentTurn(message)) return [message as Message];
    const converted: UserMessage = {
      role: 'user',
      content: JSON.stringify({
        type: message.type,
        version: message.version,
        source: message.source,
        currentRequest: message.request,
        actionEnvelope: message.actionEnvelope,
        ...(message.context ? { contextPack: message.context } : {}),
      }),
      timestamp: message.timestamp,
    };
    return [converted];
  });
}

export function isRuntimeCurrentTurn(message: unknown): message is RuntimeCurrentTurn {
  if (!isRecord(message)) return false;
  return (
    message.type === 'agentpress_current_turn' &&
    message.version === RUNTIME_CURRENT_TURN_VERSION &&
    (message.source === 'user' ||
      message.source === 'application' ||
      message.source === 'recovery') &&
    typeof message.request === 'string' &&
    typeof message.timestamp === 'number' &&
    isRecord(message.actionEnvelope)
  );
}

export function isRuntimeCompactionSummary(message: unknown): message is RuntimeCompactionSummary {
  if (!isRecord(message)) return false;
  return (
    message.type === 'agentpress_compaction_summary' &&
    message.version === 1 &&
    typeof message.summary === 'string' &&
    message.summary.length > 0 &&
    typeof message.compactionId === 'string' &&
    typeof message.tokensBefore === 'number' &&
    typeof message.timestamp === 'number'
  );
}

export function createRuntimeCompactionSummary(
  result: Extract<RuntimeContextCompactionResult, { readonly status: 'completed' }>,
  timestamp = Date.now(),
): RuntimeCompactionSummary {
  return {
    role: 'user',
    content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${result.summary}\n</summary>`,
    type: 'agentpress_compaction_summary',
    version: 1,
    summary: result.summary,
    compactionId: result.compactionId,
    tokensBefore: result.tokensBefore,
    timestamp,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

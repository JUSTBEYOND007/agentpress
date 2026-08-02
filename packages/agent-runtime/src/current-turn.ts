import type { ActionEnvelopeV1 } from '@agentpress/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message, UserMessage } from '@earendil-works/pi-ai';

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
  readonly source: 'user' | 'application';
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
  }
}

export function convertAgentPressMessages(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message) => {
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

export function isRuntimeCurrentTurn(message: AgentMessage): message is RuntimeCurrentTurn {
  return 'type' in message;
}

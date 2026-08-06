import type { RuntimeMessage } from '@agentpress/agent-runtime';

export function encodeRuntimeMessage(message: RuntimeMessage): readonly unknown[] {
  return [{ type: 'agentpress.runtime-message', version: 1, message }];
}

export function decodeRuntimeMessage(content: readonly unknown[]): RuntimeMessage | undefined {
  const envelope = content[0];
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !('type' in envelope) ||
    envelope.type !== 'agentpress.runtime-message' ||
    !('message' in envelope)
  ) {
    return undefined;
  }
  const message = envelope.message;
  if (
    typeof message !== 'object' ||
    message === null ||
    !('role' in message) ||
    (message.role !== 'user' && message.role !== 'assistant') ||
    !('content' in message) ||
    typeof message.content !== 'string' ||
    !('timestamp' in message) ||
    typeof message.timestamp !== 'number'
  ) {
    return undefined;
  }
  return message as RuntimeMessage;
}

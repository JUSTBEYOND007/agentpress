import type { AppendMessage } from '@assistant-ui/react';

import { authenticatedFetch } from './authenticated-fetch';
import type { AgentSendMode } from './agent-runtime-contracts';

export function runDirectivePath(runId: string, requestedMode?: AgentSendMode): string {
  return `runs/${runId}/${requestedMode === 'steering' ? 'steering' : 'follow-ups'}`;
}

export function messageText(message: AppendMessage): string {
  return message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim();
}

export async function requestAgentApi(
  url: string,
  body: unknown,
  idempotent = false,
): Promise<Record<string, unknown>> {
  const response = await authenticatedFetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(idempotent ? { 'idempotency-key': crypto.randomUUID() } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `请求失败 (${String(response.status)})`);
  }
  return recordValue((await response.json()) as unknown);
}

export function parseEventData(value: string): Record<string, unknown> {
  try {
    return recordValue(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

export function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

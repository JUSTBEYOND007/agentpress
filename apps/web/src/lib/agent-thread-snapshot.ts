import type { RunProjection } from './agent-runtime-contracts';
import { authenticatedFetch } from './authenticated-fetch';

export type StableAgentMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
};

export type AgentThreadSnapshot = {
  readonly messages: readonly StableAgentMessage[];
  readonly runs: readonly RunProjection[];
};

export async function loadAgentThreadSnapshot(
  apiUrl: string,
  conversationId: string,
  branchId: string,
): Promise<AgentThreadSnapshot> {
  const [messageResponse, runResponse] = await Promise.all([
    authenticatedFetch(`${apiUrl}/conversations/${conversationId}/branches/${branchId}/messages`),
    authenticatedFetch(`${apiUrl}/conversations/${conversationId}/branches/${branchId}/runs`),
  ]);
  if (!messageResponse.ok) {
    throw new Error(`对话历史加载失败 (${String(messageResponse.status)})`);
  }
  if (!runResponse.ok) throw new Error(`运行历史加载失败 (${String(runResponse.status)})`);
  return {
    messages: (await messageResponse.json()) as readonly StableAgentMessage[],
    runs: (await runResponse.json()) as readonly RunProjection[],
  };
}

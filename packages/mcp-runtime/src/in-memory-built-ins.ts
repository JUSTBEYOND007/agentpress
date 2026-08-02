import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { BuiltInMcpServerId, McpServerDefinition } from './contracts.js';

export type BuiltInSearchRequest = {
  readonly query: string;
  readonly limit: number;
  readonly runId: string;
};

export type BuiltInSearchHandlers = Record<
  BuiltInMcpServerId,
  (request: BuiltInSearchRequest, signal: AbortSignal) => Promise<unknown>
>;

export function createInMemoryBuiltInDefinitions(
  handlers: BuiltInSearchHandlers,
): readonly McpServerDefinition[] {
  return (Object.keys(handlers) as BuiltInMcpServerId[]).map((serverId) => ({
    serverId,
    version: '1.0.0',
    displayName: serverId.replaceAll('_', ' '),
    createClient: () => createLinkedClient(serverId, handlers[serverId]),
  }));
}

async function createLinkedClient(
  serverId: BuiltInMcpServerId,
  handler: BuiltInSearchHandlers[BuiltInMcpServerId],
): Promise<Client> {
  const server = new McpServer({ name: `agentpress-${serverId}`, version: '1.0.0' });
  server.registerTool(
    'search',
    {
      description: `Search the AgentPress ${serverId} source`,
      inputSchema: {
        query: z.string().min(1).max(2_000),
        limit: z.number().int().min(1).max(20).optional(),
        _agentpressRunId: z.uuid(),
      },
    },
    async ({ query, limit, _agentpressRunId }, extra) => {
      const value = await handler(
        { query, limit: limit ?? 8, runId: _agentpressRunId },
        extra.signal,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: { value },
      };
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: `agentpress-${serverId}-client`, version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

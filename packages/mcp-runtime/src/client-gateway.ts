import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { BuiltInMcpGateway } from './built-in-tools.js';
import type { BuiltInMcpServerId } from './contracts.js';
import type { McpServerManager } from './server-manager.js';

type ListedMcpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

export class McpClientGateway implements BuiltInMcpGateway {
  public constructor(private readonly manager: McpServerManager) {}

  public async call(input: Parameters<BuiltInMcpGateway['call']>[0]): Promise<unknown> {
    const client = await this.manager.getClient(input.serverId);
    try {
      // Tool calls are never replayed here: the durable AgentPress ToolCall ledger owns retries.
      const result = await client.callTool(
        {
          name: input.toolName,
          arguments: { ...input.arguments, _agentpressRunId: input.context.runId },
        },
        undefined,
        { signal: input.context.signal },
      );
      const structured = result.structuredContent;
      return typeof structured === 'object' && structured !== null && 'value' in structured
        ? structured.value
        : result;
    } catch (error) {
      if (isConnectionFailure(error)) await this.manager.markDegraded(input.serverId);
      throw error;
    }
  }

  public async listTools(serverId: BuiltInMcpServerId): Promise<readonly ListedMcpTool[]> {
    const client = await this.manager.getClient(serverId);
    try {
      const result = await client.listTools();
      return [...result.tools].sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (isConnectionFailure(error)) await this.manager.markDegraded(serverId);
      throw error;
    }
  }
}

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
}

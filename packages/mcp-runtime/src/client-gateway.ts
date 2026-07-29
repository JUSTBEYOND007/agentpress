import type { BuiltInMcpGateway } from './built-in-tools.js';
import type { McpServerManager } from './server-manager.js';

export class McpClientGateway implements BuiltInMcpGateway {
  public constructor(private readonly manager: McpServerManager) {}

  public async call(input: Parameters<BuiltInMcpGateway['call']>[0]): Promise<unknown> {
    const client = await this.manager.getClient(input.serverId);
    try {
      // Tool calls are never replayed here: the durable AgentPress ToolCall ledger owns retries.
      return await client.callTool(
        { name: input.toolName, arguments: input.arguments },
        undefined,
        { signal: input.context.signal },
      );
    } catch (error) {
      if (isConnectionFailure(error)) await this.manager.markDegraded(input.serverId);
      throw error;
    }
  }
}

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
}

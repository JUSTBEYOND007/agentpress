import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { BuiltInMcpServerId, McpServerDefinition, McpServerState } from './contracts.js';

export class McpServerManager {
  private readonly states = new Map<BuiltInMcpServerId, McpServerState>();
  private readonly clients = new Map<BuiltInMcpServerId, Client>();
  private readonly definitions = new Map<BuiltInMcpServerId, McpServerDefinition>();
  private readonly starts = new Map<BuiltInMcpServerId, Promise<Client>>();

  public register(definition: McpServerDefinition): void {
    if (this.definitions.has(definition.serverId)) {
      throw new Error(`MCP Server ${definition.serverId} is already registered`);
    }
    this.definitions.set(definition.serverId, definition);
    this.states.set(definition.serverId, 'idle');
  }

  public state(serverId: BuiltInMcpServerId): McpServerState {
    return this.states.get(serverId) ?? 'stopped';
  }

  public async getClient(serverId: BuiltInMcpServerId): Promise<Client> {
    const existing = this.clients.get(serverId);
    if (existing) {
      return existing;
    }
    const starting = this.starts.get(serverId);
    if (starting) return starting;
    const definition = this.definitions.get(serverId);
    if (!definition) {
      throw new Error(`MCP Server ${serverId} is not registered`);
    }
    this.states.set(serverId, 'starting');
    const start = (async () => {
      try {
        const client = await definition.createClient();
        this.clients.set(serverId, client);
        this.states.set(serverId, 'ready');
        return client;
      } catch (error) {
        this.states.set(serverId, 'degraded');
        throw error;
      } finally {
        this.starts.delete(serverId);
      }
    })();
    this.starts.set(serverId, start);
    return start;
  }

  public async markDegraded(serverId: BuiltInMcpServerId): Promise<void> {
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    this.states.set(serverId, 'degraded');
    if (client) await client.close();
  }

  public async stop(serverId: BuiltInMcpServerId): Promise<void> {
    const starting = this.starts.get(serverId);
    if (starting) await starting.catch(() => undefined);
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    this.states.set(serverId, 'stopped');
    if (client) {
      await client.close();
    }
  }
}

// Lifecycle behavior adapted from pi-mcp-adapter e588296 and Oh My Pi f446b8a (MIT).
// Copyright (c) 2026 Nico Bailon; Copyright (c) 2025 Mario Zechner.
// Copyright (c) 2025-2026 Can Boluk.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { BuiltInMcpServerId, McpServerDefinition, McpServerState } from './contracts.js';

export class McpCircuitOpenError extends Error {
  public constructor(
    public readonly serverId: BuiltInMcpServerId,
    public readonly retryAt: Date,
  ) {
    super(`MCP Server ${serverId} reconnect circuit is open until ${retryAt.toISOString()}`);
    this.name = 'McpCircuitOpenError';
  }
}

export type McpServerManagerOptions = {
  readonly reconnectFailureThreshold?: number;
  readonly reconnectCooldownMs?: number;
  readonly now?: () => Date;
};

export class McpServerManager {
  private readonly states = new Map<BuiltInMcpServerId, McpServerState>();
  private readonly clients = new Map<BuiltInMcpServerId, Client>();
  private readonly definitions = new Map<BuiltInMcpServerId, McpServerDefinition>();
  private readonly starts = new Map<BuiltInMcpServerId, Promise<Client>>();
  private readonly failures = new Map<
    BuiltInMcpServerId,
    { readonly count: number; readonly openedAt?: Date }
  >();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => Date;

  public constructor(options: McpServerManagerOptions = {}) {
    this.failureThreshold = options.reconnectFailureThreshold ?? 3;
    this.cooldownMs = options.reconnectCooldownMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.failureThreshold) || this.failureThreshold < 1) {
      throw new RangeError('MCP reconnect failure threshold must be positive');
    }
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 1) {
      throw new RangeError('MCP reconnect cooldown must be positive');
    }
  }

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

  public listRegistered(): readonly BuiltInMcpServerId[] {
    return [...this.definitions.keys()].sort();
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
    this.assertCircuitClosed(serverId);
    this.states.set(serverId, 'starting');
    const start = (async () => {
      try {
        const client = await definition.createClient();
        this.clients.set(serverId, client);
        this.states.set(serverId, 'ready');
        this.failures.delete(serverId);
        return client;
      } catch (error) {
        this.states.set(serverId, 'degraded');
        this.recordFailure(serverId);
        throw error;
      } finally {
        this.starts.delete(serverId);
      }
    })();
    this.starts.set(serverId, start);
    return start;
  }

  public async markDegraded(
    serverId: BuiltInMcpServerId,
    expectedClient?: Client,
  ): Promise<boolean> {
    const client = this.clients.get(serverId);
    if (expectedClient && client !== expectedClient) return false;
    this.clients.delete(serverId);
    this.states.set(serverId, 'degraded');
    this.recordFailure(serverId);
    if (client) await client.close().catch(() => undefined);
    return true;
  }

  public async stop(serverId: BuiltInMcpServerId): Promise<void> {
    const starting = this.starts.get(serverId);
    if (starting) await starting.catch(() => undefined);
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    this.failures.delete(serverId);
    this.states.set(serverId, 'stopped');
    if (client) {
      await client.close();
    }
  }

  private assertCircuitClosed(serverId: BuiltInMcpServerId): void {
    const failure = this.failures.get(serverId);
    if (!failure?.openedAt) return;
    const retryAt = new Date(failure.openedAt.getTime() + this.cooldownMs);
    if (retryAt.getTime() > this.now().getTime()) throw new McpCircuitOpenError(serverId, retryAt);
    this.failures.delete(serverId);
  }

  private recordFailure(serverId: BuiltInMcpServerId): void {
    const count = (this.failures.get(serverId)?.count ?? 0) + 1;
    this.failures.set(serverId, {
      count,
      ...(count >= this.failureThreshold ? { openedAt: this.now() } : {}),
    });
  }
}

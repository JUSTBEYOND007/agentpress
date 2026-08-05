// Reconnect behavior adapted from Oh My Pi v17.1.8, commit f446b8a (MIT).
// Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Boluk.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { BuiltInMcpGateway } from './built-in-tools.js';
import type { BuiltInMcpServerId, McpNotificationHandlers } from './contracts.js';
import type { McpServerManager } from './server-manager.js';

type ListedMcpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

export class McpClientGateway implements BuiltInMcpGateway {
  public constructor(private readonly manager: McpServerManager) {}

  public async call(input: Parameters<BuiltInMcpGateway['call']>[0]): Promise<unknown> {
    let client = await this.manager.getClient(input.serverId);
    try {
      return await callTool(client, input);
    } catch (error) {
      if (!isConnectionFailure(error)) throw error;
      await this.manager.markDegraded(input.serverId, client);
      throwIfAborted(input.context.signal);
      client = await this.reconnectClient(input.serverId, input.context.signal);
      try {
        return await callTool(client, input);
      } catch (retryError) {
        if (isConnectionFailure(retryError)) {
          await this.manager.markDegraded(input.serverId, client);
        }
        throw retryError;
      }
    }
  }

  public async listTools(serverId: BuiltInMcpServerId): Promise<readonly ListedMcpTool[]> {
    const client = await this.manager.getClient(serverId);
    try {
      const result = await client.listTools();
      return [...result.tools].sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (isConnectionFailure(error)) await this.manager.markDegraded(serverId, client);
      throw error;
    }
  }

  public async listPrompts(serverId: BuiltInMcpServerId) {
    const client = await this.manager.getClient(serverId);
    const result = await client.listPrompts();
    return {
      ...result,
      prompts: [...result.prompts].sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  public async getPrompt(
    serverId: BuiltInMcpServerId,
    ...args: Parameters<Client['getPrompt']>
  ): Promise<Awaited<ReturnType<Client['getPrompt']>>> {
    const client = await this.manager.getClient(serverId);
    return client.getPrompt(...args);
  }

  public async listResources(serverId: BuiltInMcpServerId) {
    const client = await this.manager.getClient(serverId);
    const result = await client.listResources();
    return {
      ...result,
      resources: [...result.resources].sort((left, right) => left.uri.localeCompare(right.uri)),
    };
  }

  public async readResource(
    serverId: BuiltInMcpServerId,
    ...args: Parameters<Client['readResource']>
  ): Promise<Awaited<ReturnType<Client['readResource']>>> {
    const client = await this.manager.getClient(serverId);
    return client.readResource(...args);
  }

  public async listResourceTemplates(serverId: BuiltInMcpServerId) {
    const client = await this.manager.getClient(serverId);
    const result = await client.listResourceTemplates();
    return {
      ...result,
      resourceTemplates: [...result.resourceTemplates].sort((left, right) =>
        left.uriTemplate.localeCompare(right.uriTemplate),
      ),
    };
  }

  public async subscribeResource(
    serverId: BuiltInMcpServerId,
    ...args: Parameters<Client['subscribeResource']>
  ): Promise<Awaited<ReturnType<Client['subscribeResource']>>> {
    const client = await this.manager.getClient(serverId);
    return client.subscribeResource(...args);
  }

  public async unsubscribeResource(
    serverId: BuiltInMcpServerId,
    ...args: Parameters<Client['unsubscribeResource']>
  ): Promise<Awaited<ReturnType<Client['unsubscribeResource']>>> {
    const client = await this.manager.getClient(serverId);
    return client.unsubscribeResource(...args);
  }

  public async registerNotificationHandlers(
    serverId: BuiltInMcpServerId,
    handlers: McpNotificationHandlers,
  ): Promise<void> {
    const client = await this.manager.getClient(serverId);
    if (handlers.resourceUpdated) {
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, handlers.resourceUpdated);
    }
    if (handlers.resourceListChanged) {
      client.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        handlers.resourceListChanged,
      );
    }
    if (handlers.promptListChanged) {
      client.setNotificationHandler(
        PromptListChangedNotificationSchema,
        handlers.promptListChanged,
      );
    }
    if (handlers.toolListChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, handlers.toolListChanged);
    }
  }

  private async reconnectClient(
    serverId: BuiltInMcpServerId,
    signal: AbortSignal,
  ): Promise<Client> {
    try {
      return await this.manager.getClient(serverId);
    } catch (error) {
      throwIfAborted(signal);
      if (!isConnectionFailure(error)) throw error;
      return this.manager.getClient(serverId);
    }
  }
}

async function callTool(
  client: Client,
  input: Parameters<BuiltInMcpGateway['call']>[0],
): Promise<unknown> {
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
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('MCP tool call was aborted');
}

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'UND_ERR_SOCKET',
    ].includes(code)
  ) {
    return true;
  }
  const message = error.message.toLocaleLowerCase();
  return (
    /^http (404|502|503):/.test(message) ||
    [
      'econnrefused',
      'econnreset',
      'epipe',
      'enetunreach',
      'ehostunreach',
      'fetch failed',
      'transport not connected',
      'transport closed',
      'network error',
    ].some((pattern) => message.includes(pattern))
  );
}

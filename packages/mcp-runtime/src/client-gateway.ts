// Reconnect behavior adapted from Oh My Pi v17.1.8, commit f446b8a (MIT).
// Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Boluk.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  McpError,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ToolExecutionError,
  ToolRuntimeError,
  type ToolExecutionOutcomeReason,
} from '@agentpress/tool-runtime';

import type { BuiltInMcpGateway } from './built-in-tools.js';
import type {
  BuiltInMcpServerId,
  McpNotificationHandlers,
  McpTransportAuditEvent,
  McpTransportAuditObserver,
} from './contracts.js';
import type { McpServerManager } from './server-manager.js';

type ListedMcpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
const MCP_CONNECTION_CLOSED_CODE = -32_000;

export type McpCallOutcomeUnknownReason = 'connection_lost_after_dispatch' | 'stale_client_result';

export class McpCallBeforeDispatchError extends ToolExecutionError {
  public override readonly name = 'McpCallBeforeDispatchError';

  public constructor(
    public readonly serverId: BuiltInMcpServerId,
    public readonly toolName: string,
    cause?: unknown,
    reason: Extract<
      ToolExecutionOutcomeReason,
      'connection_unavailable_before_dispatch' | 'initialization_failed_before_dispatch'
    > = 'connection_unavailable_before_dispatch',
  ) {
    super(`MCP tool ${toolName} failed before dispatch`, 'known_failed', reason);
    this.cause = cause;
  }

  public override readonly cause?: unknown;
}

export class McpAuthenticationError extends ToolRuntimeError {
  public override readonly name = 'McpAuthenticationError';

  public constructor(
    public readonly serverId: BuiltInMcpServerId,
    public readonly toolName: string,
  ) {
    super('tool_authentication_failed', `MCP tool ${toolName} authentication failed`, {
      serverId,
      toolName,
    });
  }
}

export class McpCallOutcomeUnknownError extends ToolExecutionError {
  public override readonly name = 'McpCallOutcomeUnknownError';
  public override readonly cause?: unknown;

  public constructor(
    public readonly serverId: BuiltInMcpServerId,
    public readonly toolName: string,
    public readonly reason: McpCallOutcomeUnknownReason,
    cause?: unknown,
  ) {
    super(
      `MCP tool ${toolName} outcome is unknown after ${reason.replaceAll('_', ' ')}`,
      'unknown',
      reason,
    );
    this.cause = cause;
  }
}

export class McpRateLimitError extends ToolRuntimeError {
  public override readonly name = 'McpRateLimitError';

  public constructor(
    public readonly serverId: BuiltInMcpServerId,
    public readonly toolName: string,
  ) {
    super('tool_rate_limited', `MCP tool ${toolName} was rate limited`, {
      serverId,
      toolName,
    });
  }
}

export class McpProtocolError extends Error {
  public override readonly name = 'McpProtocolError';

  public constructor(
    public readonly serverId: BuiltInMcpServerId,
    public readonly protocolCode?: number,
  ) {
    super('MCP protocol request failed');
  }
}

export class McpClientGateway implements BuiltInMcpGateway {
  public constructor(
    private readonly manager: McpServerManager,
    private readonly observer?: McpTransportAuditObserver,
  ) {}

  public async call(input: Parameters<BuiltInMcpGateway['call']>[0]): Promise<unknown> {
    const client = await this.getClientBeforeCall(input);
    try {
      const result = await callTool(client, input);
      if (!this.manager.isCurrentClient(input.serverId, client)) {
        throw new McpCallOutcomeUnknownError(input.serverId, input.toolName, 'stale_client_result');
      }
      return result;
    } catch (error) {
      if (error instanceof McpCallOutcomeUnknownError) throw error;
      if (error instanceof StreamableHTTPError && error.code === 429) {
        throw new McpRateLimitError(input.serverId, input.toolName);
      }
      if (error instanceof McpError && !isConnectionFailure(error)) {
        throw new McpProtocolError(input.serverId, error.code);
      }
      if (!isConnectionFailure(error)) throw error;
      await this.manager.markDegraded(input.serverId, client);
      throwIfAborted(input.context.signal);
      throw new McpCallOutcomeUnknownError(
        input.serverId,
        input.toolName,
        'connection_lost_after_dispatch',
        error,
      );
    }
  }

  public async listTools(serverId: BuiltInMcpServerId): Promise<readonly ListedMcpTool[]> {
    const client = await this.manager.getClient(serverId);
    try {
      const result = await client.listTools();
      const tools = [...result.tools];
      validateListedTools(tools);
      return tools.sort((left, right) => left.name.localeCompare(right.name));
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

  private async getClientBeforeCall(
    input: Parameters<BuiltInMcpGateway['call']>[0],
  ): Promise<Client> {
    let retryOrdinal = 0;
    const reconnecting = this.manager.state(input.serverId) === 'degraded';
    if (reconnecting) {
      retryOrdinal += 1;
      await this.emitTransportEvent(input, 'retry_attempted', 'degraded_client', retryOrdinal);
    }
    try {
      const client = await this.manager.getClient(input.serverId);
      if (reconnecting) {
        await this.emitTransportEvent(input, 'reconnected', 'degraded_client', retryOrdinal);
      }
      return client;
    } catch (error) {
      throwIfAborted(input.context.signal);
      if (isAuthenticationFailure(error)) {
        throw new McpAuthenticationError(input.serverId, input.toolName);
      }
      if (!isConnectionFailure(error)) {
        throw new McpCallBeforeDispatchError(
          input.serverId,
          input.toolName,
          undefined,
          'initialization_failed_before_dispatch',
        );
      }
      retryOrdinal += 1;
      await this.emitTransportEvent(input, 'retry_attempted', 'connect_failure', retryOrdinal);
      try {
        const client = await this.manager.getClient(input.serverId);
        await this.emitTransportEvent(input, 'reconnected', 'connect_failure', retryOrdinal);
        return client;
      } catch (retryError) {
        throwIfAborted(input.context.signal);
        if (isAuthenticationFailure(retryError)) {
          throw new McpAuthenticationError(input.serverId, input.toolName);
        }
        if (isConnectionFailure(retryError)) {
          throw new McpCallBeforeDispatchError(input.serverId, input.toolName, retryError);
        }
        throw new McpCallBeforeDispatchError(
          input.serverId,
          input.toolName,
          undefined,
          'initialization_failed_before_dispatch',
        );
      }
    }
  }

  private async emitTransportEvent(
    input: Parameters<BuiltInMcpGateway['call']>[0],
    event: McpTransportAuditEvent['event'],
    reason: McpTransportAuditEvent['reason'],
    retryOrdinal: number,
  ): Promise<void> {
    await this.observer?.onTransportEvent({
      event,
      phase: 'before_dispatch',
      reason,
      retryOrdinal,
      serverId: input.serverId,
      toolName: input.toolName,
      runId: input.context.runId,
      toolCallId: input.context.toolCallId,
    });
  }
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403);
}

function validateListedTools(tools: readonly ListedMcpTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool.name.trim() || names.has(tool.name)) {
      throw new Error('MCP tool list contains an empty or duplicate tool name');
    }
    names.add(tool.name);
    if (!isObjectSchema(tool.inputSchema)) {
      throw new Error(`MCP tool ${tool.name} has an invalid input schema`);
    }
  }
}

function isObjectSchema(value: unknown): value is { readonly type: 'object' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly type?: unknown }).type === 'object'
  );
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
  if (result.isError === true) {
    throw new McpProtocolError(input.serverId);
  }
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
  if (error instanceof McpError && error.code === MCP_CONNECTION_CLOSED_CODE) return true;
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

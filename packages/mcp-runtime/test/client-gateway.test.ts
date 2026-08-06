// Reconnect tests adapted from Oh My Pi v17.1.8, commit f446b8a (MIT).
// Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Boluk.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';

import { McpClientGateway, McpServerManager } from '../src/index.js';

describe('MCP client gateway', () => {
  it('reconnects and retries a read-only tool call exactly once after a transport failure', async () => {
    const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const firstCall = vi.fn(() => Promise.reject(error));
    const secondCall = vi.fn(() =>
      Promise.resolve({ structuredContent: { value: { results: ['recovered'] } } }),
    );
    const firstClose = vi.fn(() => Promise.resolve());
    let connection = 0;
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => {
        connection += 1;
        return Promise.resolve(
          connection === 1
            ? ({ callTool: firstCall, close: firstClose } as unknown as Client)
            : ({ callTool: secondCall, close: () => Promise.resolve() } as unknown as Client),
        );
      },
    });
    const gateway = new McpClientGateway(manager);
    await expect(
      gateway.call({
        serverId: 'web_research',
        toolName: 'search',
        arguments: { query: 'Kafka' },
        context: {
          runId: 'run',
          toolCallId: 'call',
          signal: new AbortController().signal,
        },
      }),
    ).resolves.toEqual({ results: ['recovered'] });
    expect(firstCall).toHaveBeenCalledTimes(1);
    expect(secondCall).toHaveBeenCalledTimes(1);
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(connection).toBe(2);
    expect(manager.state('web_research')).toBe('ready');
  });

  it('does not retry non-connection errors or retry a second connection failure', async () => {
    const internal = new Error('MCP error -32603: Internal error');
    const internalCall = vi.fn(() => Promise.reject(internal));
    const internalManager = managerWithClients([
      { callTool: internalCall, close: () => Promise.resolve() } as unknown as Client,
    ]);
    const input = toolCallInput();
    await expect(new McpClientGateway(internalManager).call(input)).rejects.toBe(internal);
    expect(internalCall).toHaveBeenCalledTimes(1);

    const firstError = new Error('Transport closed');
    const secondError = new Error('HTTP 503: Service Unavailable');
    const firstCall = vi.fn(() => Promise.reject(firstError));
    const secondCall = vi.fn(() => Promise.reject(secondError));
    const retryManager = managerWithClients([
      { callTool: firstCall, close: () => Promise.resolve() } as unknown as Client,
      { callTool: secondCall, close: () => Promise.resolve() } as unknown as Client,
    ]);
    await expect(new McpClientGateway(retryManager).call(input)).rejects.toBe(secondError);
    expect(firstCall).toHaveBeenCalledTimes(1);
    expect(secondCall).toHaveBeenCalledTimes(1);
    expect(retryManager.state('web_research')).toBe('degraded');
  });

  it('fails closed on an MCP error result without retaining remote content', async () => {
    const callTool = vi.fn(() =>
      Promise.resolve({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'username=generated password=generated api_key=generated',
          },
        ],
      }),
    );
    const manager = managerWithClients([
      { callTool, close: () => Promise.resolve() } as unknown as Client,
    ]);

    await expect(new McpClientGateway(manager).call(toolCallInput())).rejects.toThrow(
      'MCP tool search returned an error',
    );
    await expect(new McpClientGateway(manager).call(toolCallInput())).rejects.not.toThrow(
      /password|api_key|generated/u,
    );
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(manager.state('web_research')).toBe('ready');
  });

  it('coalesces concurrent reconnects and does not let stale failures evict the new client', async () => {
    const transportFailure = new Error('fetch failed');
    const oldCall = vi.fn(() => Promise.reject(transportFailure));
    const newCall = vi.fn(() => Promise.resolve({ structuredContent: { value: 'ok' } }));
    const manager = managerWithClients([
      { callTool: oldCall, close: () => Promise.resolve() } as unknown as Client,
      { callTool: newCall, close: () => Promise.resolve() } as unknown as Client,
    ]);
    const gateway = new McpClientGateway(manager);

    await expect(
      Promise.all([gateway.call(toolCallInput('call-a')), gateway.call(toolCallInput('call-b'))]),
    ).resolves.toEqual(['ok', 'ok']);
    expect(oldCall).toHaveBeenCalledTimes(2);
    expect(newCall).toHaveBeenCalledTimes(2);
    expect(manager.state('web_research')).toBe('ready');
  });

  it('allows one bounded reconnect probe when the first fresh connection also resets', async () => {
    const oldCall = vi.fn(() => Promise.reject(new Error('Transport closed')));
    const recoveredCall = vi.fn(() =>
      Promise.resolve({ structuredContent: { value: 'recovered' } }),
    );
    const oldClient = {
      callTool: oldCall,
      close: () => Promise.resolve(),
    } as unknown as Client;
    const recoveredClient = {
      callTool: recoveredCall,
      close: () => Promise.resolve(),
    } as unknown as Client;
    let connection = 0;
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => {
        connection += 1;
        if (connection === 1) return Promise.resolve(oldClient);
        if (connection === 2) return Promise.reject(new Error('fetch failed'));
        return Promise.resolve(recoveredClient);
      },
    });

    await expect(new McpClientGateway(manager).call(toolCallInput())).resolves.toBe('recovered');
    expect(connection).toBe(3);
    expect(oldCall).toHaveBeenCalledTimes(1);
    expect(recoveredCall).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect when cancellation wins after a connection failure', async () => {
    const controller = new AbortController();
    const aborted = new Error('cancelled by user');
    const callTool = vi.fn(() => {
      controller.abort(aborted);
      return Promise.reject(new Error('Transport closed'));
    });
    const create = vi.fn(() =>
      Promise.resolve({ callTool, close: () => Promise.resolve() } as unknown as Client),
    );
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: create,
    });

    await expect(
      new McpClientGateway(manager).call(toolCallInput('cancelled', controller.signal)),
    ).rejects.toBe(aborted);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('sorts discovered tools independently of server response order', async () => {
    const listTools = vi.fn(() =>
      Promise.resolve({
        tools: [
          { name: 'zeta', inputSchema: { type: 'object' as const } },
          { name: 'alpha', inputSchema: { type: 'object' as const } },
        ],
      }),
    );
    const manager = new McpServerManager();
    manager.register({
      serverId: 'workspace_knowledge',
      version: '1',
      displayName: 'Knowledge',
      createClient: () =>
        Promise.resolve({ listTools, close: () => Promise.resolve() } as unknown as Client),
    });
    const gateway = new McpClientGateway(manager);
    await expect(gateway.listTools('workspace_knowledge')).resolves.toMatchObject([
      { name: 'alpha' },
      { name: 'zeta' },
    ]);
  });

  it('reuses SDK prompt/resource APIs with deterministic listing order', async () => {
    const client = {
      listPrompts: vi.fn(() => Promise.resolve({ prompts: [{ name: 'z' }, { name: 'a' }] })),
      getPrompt: vi.fn(() => Promise.resolve({ messages: [] })),
      listResources: vi.fn(() =>
        Promise.resolve({ resources: [{ uri: 'mcp://z' }, { uri: 'mcp://a' }] }),
      ),
      readResource: vi.fn(() => Promise.resolve({ contents: [] })),
      listResourceTemplates: vi.fn(() =>
        Promise.resolve({
          resourceTemplates: [{ uriTemplate: 'z/{id}' }, { uriTemplate: 'a/{id}' }],
        }),
      ),
      subscribeResource: vi.fn(() => Promise.resolve({})),
      unsubscribeResource: vi.fn(() => Promise.resolve({})),
      setNotificationHandler: vi.fn(),
      close: () => Promise.resolve(),
    } as unknown as Client;
    const manager = new McpServerManager();
    manager.register({
      serverId: 'licensed_media',
      version: '1',
      displayName: 'Media',
      createClient: () => Promise.resolve(client),
    });
    const gateway = new McpClientGateway(manager);
    await expect(gateway.listPrompts('licensed_media')).resolves.toMatchObject({
      prompts: [{ name: 'a' }, { name: 'z' }],
    });
    await expect(gateway.listResources('licensed_media')).resolves.toMatchObject({
      resources: [{ uri: 'mcp://a' }, { uri: 'mcp://z' }],
    });
    await expect(gateway.listResourceTemplates('licensed_media')).resolves.toMatchObject({
      resourceTemplates: [{ uriTemplate: 'a/{id}' }, { uriTemplate: 'z/{id}' }],
    });
    await gateway.getPrompt('licensed_media', { name: 'a' });
    await gateway.readResource('licensed_media', { uri: 'mcp://a' });
    await gateway.subscribeResource('licensed_media', { uri: 'mcp://a' });
    await gateway.unsubscribeResource('licensed_media', { uri: 'mcp://a' });
    await gateway.registerNotificationHandlers('licensed_media', {
      resourceUpdated: vi.fn(),
      resourceListChanged: vi.fn(),
      promptListChanged: vi.fn(),
      toolListChanged: vi.fn(),
    });
    expect((client.getPrompt as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(
      1,
    );
    expect(
      (client.readResource as unknown as { mock: { calls: unknown[] } }).mock.calls,
    ).toHaveLength(1);
    expect(
      (client.subscribeResource as unknown as { mock: { calls: unknown[] } }).mock.calls,
    ).toHaveLength(1);
    expect(
      (client.unsubscribeResource as unknown as { mock: { calls: unknown[] } }).mock.calls,
    ).toHaveLength(1);
    expect(
      (client.setNotificationHandler as unknown as { mock: { calls: unknown[] } }).mock.calls,
    ).toHaveLength(4);
  });
});

function toolCallInput(toolCallId = 'call', signal = new AbortController().signal) {
  return {
    serverId: 'web_research' as const,
    toolName: 'search',
    arguments: { query: 'Kafka' },
    context: { runId: 'run', toolCallId, signal },
  };
}

function managerWithClients(clients: readonly Client[]): McpServerManager {
  let index = 0;
  const manager = new McpServerManager();
  manager.register({
    serverId: 'web_research',
    version: '1',
    displayName: 'Web',
    createClient: () => {
      const client = clients[index];
      index += 1;
      return client ? Promise.resolve(client) : Promise.reject(new Error('No fake MCP client'));
    },
  });
  return manager;
}

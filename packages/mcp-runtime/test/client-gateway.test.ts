// Reconnect tests adapted from Oh My Pi v17.1.8, commit f446b8a (MIT).
// Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Boluk.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';

import { McpClientGateway, McpServerManager } from '../src/index.js';

describe('MCP client gateway', () => {
  it('does not replay an outcome-unknown call and reconnects for the next logical call', async () => {
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
    await expect(gateway.call(toolCallInput('outcome-unknown'))).rejects.toMatchObject({
      name: 'McpCallOutcomeUnknownError',
      serverId: 'web_research',
      toolName: 'search',
      reason: 'connection_lost',
      cause: error,
    });
    expect(firstCall).toHaveBeenCalledTimes(1);
    expect(secondCall).not.toHaveBeenCalled();
    expect(connection).toBe(1);
    expect(manager.state('web_research')).toBe('degraded');

    await expect(gateway.call(toolCallInput('next-logical-call'))).resolves.toEqual({
      results: ['recovered'],
    });
    expect(secondCall).toHaveBeenCalledTimes(1);
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(connection).toBe(2);
    expect(manager.state('web_research')).toBe('ready');
  });

  it('allows one connection probe before invoking a tool', async () => {
    const callTool = vi.fn(() => Promise.resolve({ structuredContent: { value: 'ok' } }));
    let connection = 0;
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => {
        connection += 1;
        return connection === 1
          ? Promise.reject(new Error('fetch failed'))
          : Promise.resolve({ callTool, close: () => Promise.resolve() } as unknown as Client);
      },
    });

    await expect(new McpClientGateway(manager).call(toolCallInput())).resolves.toBe('ok');
    expect(connection).toBe(2);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('does not retire the current client for a non-connection tool error', async () => {
    const internal = new Error('MCP error -32603: Internal error');
    const internalCall = vi.fn(() => Promise.reject(internal));
    const internalManager = managerWithClients([
      { callTool: internalCall, close: () => Promise.resolve() } as unknown as Client,
    ]);
    const input = toolCallInput();
    await expect(new McpClientGateway(internalManager).call(input)).rejects.toBe(internal);
    expect(internalCall).toHaveBeenCalledTimes(1);
    expect(internalManager.state('web_research')).toBe('ready');
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

  it('rejects an old client result that arrives after a concurrent disconnect', async () => {
    const transportFailure = new Error('fetch failed');
    let settleLateResult: ((value: { structuredContent: { value: string } }) => void) | undefined;
    const lateResult = new Promise<{ structuredContent: { value: string } }>((resolve) => {
      settleLateResult = resolve;
    });
    let markFirstCallStarted: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((resolve) => {
      markFirstCallStarted = resolve;
    });
    let oldInvocation = 0;
    const oldCall = vi.fn(() => {
      oldInvocation += 1;
      if (oldInvocation === 1) {
        markFirstCallStarted?.();
        return lateResult;
      }
      return Promise.reject(transportFailure);
    });
    const newCall = vi.fn(() => Promise.resolve({ structuredContent: { value: 'ok' } }));
    const oldClose = vi.fn(() => Promise.resolve());
    const manager = managerWithClients([
      { callTool: oldCall, close: oldClose } as unknown as Client,
      { callTool: newCall, close: () => Promise.resolve() } as unknown as Client,
    ]);
    const gateway = new McpClientGateway(manager);

    const pendingLateResult = gateway.call(toolCallInput('late-result'));
    await firstCallStarted;
    await expect(gateway.call(toolCallInput('disconnecting-call'))).rejects.toMatchObject({
      name: 'McpCallOutcomeUnknownError',
      reason: 'connection_lost',
    });
    settleLateResult?.({ structuredContent: { value: 'stale' } });
    await expect(pendingLateResult).rejects.toMatchObject({
      name: 'McpCallOutcomeUnknownError',
      reason: 'stale_client_result',
    });
    expect(oldCall).toHaveBeenCalledTimes(2);
    expect(oldClose).toHaveBeenCalledTimes(1);
    expect(newCall).not.toHaveBeenCalled();
    expect(manager.state('web_research')).toBe('degraded');

    await expect(gateway.call(toolCallInput('fresh-call'))).resolves.toBe('ok');
    expect(newCall).toHaveBeenCalledTimes(1);
    expect(manager.state('web_research')).toBe('ready');
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

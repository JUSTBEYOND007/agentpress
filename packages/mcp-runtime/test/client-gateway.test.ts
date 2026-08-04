import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';

import { McpClientGateway, McpServerManager } from '../src/index.js';

describe('MCP client gateway', () => {
  it('does not duplicate a failed tool call and degrades transport failures', async () => {
    const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const callTool = vi.fn(() => Promise.reject(error));
    const close = vi.fn(() => Promise.resolve());
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => Promise.resolve({ callTool, close } as unknown as Client),
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
    ).rejects.toBe(error);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.state('web_research')).toBe('degraded');
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

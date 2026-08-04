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
});

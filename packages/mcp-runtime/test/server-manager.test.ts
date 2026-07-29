import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';

import { McpServerManager } from '../src/index.js';

function fakeClient(close = vi.fn(() => Promise.resolve())): Client {
  return { close } as unknown as Client;
}

describe('MCP Server lifecycle', () => {
  it('starts lazily and coalesces concurrent startup', async () => {
    const manager = new McpServerManager();
    const create = vi.fn(() => Promise.resolve(fakeClient()));
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: create,
    });
    expect(manager.state('web_research')).toBe('idle');
    const [a, b] = await Promise.all([
      manager.getClient('web_research'),
      manager.getClient('web_research'),
    ]);
    expect(a).toBe(b);
    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.state('web_research')).toBe('ready');
  });

  it('degrades on failure and permits a later recovery attempt', async () => {
    const manager = new McpServerManager();
    const client = fakeClient();
    let attempt = 0;
    manager.register({
      serverId: 'workspace_knowledge',
      version: '1',
      displayName: 'Knowledge',
      createClient: () => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error('offline'));
        return Promise.resolve(client);
      },
    });
    await expect(manager.getClient('workspace_knowledge')).rejects.toThrow('offline');
    expect(manager.state('workspace_knowledge')).toBe('degraded');
    await expect(manager.getClient('workspace_knowledge')).resolves.toBe(client);
    expect(attempt).toBe(2);
  });

  it('closes degraded and stopped clients exactly once', async () => {
    const close = vi.fn(() => Promise.resolve());
    const manager = new McpServerManager();
    manager.register({
      serverId: 'licensed_media',
      version: '1',
      displayName: 'Media',
      createClient: () => Promise.resolve(fakeClient(close)),
    });
    await manager.getClient('licensed_media');
    await manager.markDegraded('licensed_media');
    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.state('licensed_media')).toBe('degraded');
    await manager.stop('licensed_media');
    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.state('licensed_media')).toBe('stopped');
  });
});

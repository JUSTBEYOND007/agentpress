// Behavior tests adapted from pi-mcp-adapter e588296 and Oh My Pi f446b8a (MIT).
// Copyright (c) 2026 Nico Bailon; Copyright (c) 2025 Mario Zechner.
// Copyright (c) 2025-2026 Can Boluk.
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

  it('ignores a stale failure from a client that has already been replaced', async () => {
    const oldClient = fakeClient();
    const newClient = fakeClient();
    let attempt = 0;
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => Promise.resolve(attempt++ === 0 ? oldClient : newClient),
    });
    await manager.getClient('web_research');
    await expect(manager.markDegraded('web_research', oldClient)).resolves.toBe(true);
    await expect(manager.getClient('web_research')).resolves.toBe(newClient);
    await expect(manager.markDegraded('web_research', oldClient)).resolves.toBe(false);
    await expect(manager.getClient('web_research')).resolves.toBe(newClient);
    expect(manager.state('web_research')).toBe('ready');
  });

  it('opens a reconnect-storm circuit and permits one probe after cooldown', async () => {
    let now = new Date('2026-08-04T00:00:00.000Z');
    let attempt = 0;
    const recovered = fakeClient();
    const manager = new McpServerManager({
      reconnectFailureThreshold: 2,
      reconnectCooldownMs: 1_000,
      now: () => now,
    });
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => {
        attempt += 1;
        return attempt <= 2 ? Promise.reject(new Error('offline')) : Promise.resolve(recovered);
      },
    });
    await expect(manager.getClient('web_research')).rejects.toThrow('offline');
    await expect(manager.getClient('web_research')).rejects.toThrow('offline');
    await expect(manager.getClient('web_research')).rejects.toMatchObject({
      name: 'McpCircuitOpenError',
    });
    expect(attempt).toBe(2);
    now = new Date('2026-08-04T00:00:01.001Z');
    await expect(manager.getClient('web_research')).resolves.toBe(recovered);
    expect(attempt).toBe(3);
  });

  it('lists registered built-ins in stable order', () => {
    const manager = new McpServerManager();
    for (const serverId of ['workspace_knowledge', 'web_research', 'licensed_media'] as const) {
      manager.register({
        serverId,
        version: '1',
        displayName: serverId,
        createClient: () => Promise.resolve(fakeClient()),
      });
    }
    expect(manager.listRegistered()).toEqual([
      'licensed_media',
      'web_research',
      'workspace_knowledge',
    ]);
  });
});

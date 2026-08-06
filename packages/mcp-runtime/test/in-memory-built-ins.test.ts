import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryBuiltInDefinitions,
  McpClientGateway,
  McpServerManager,
} from '../src/index.js';

describe('in-memory built-in MCP servers', () => {
  it('uses the official client/server transport and binds internal Run identity', async () => {
    const search = vi.fn((request: unknown) => Promise.resolve([{ evidenceId: 'e-1', request }]));
    const manager = new McpServerManager();
    for (const definition of createInMemoryBuiltInDefinitions({
      web_research: search,
      workspace_knowledge: search,
      licensed_media: search,
    })) {
      manager.register(definition);
    }
    const gateway = new McpClientGateway(manager);
    const output = await gateway.call({
      serverId: 'workspace_knowledge',
      toolName: 'search',
      arguments: { query: 'Kafka', limit: 3 },
      context: {
        runId: '0f911cbe-9cb5-465f-b9ae-267597d95f37',
        toolCallId: 'call-1',
        signal: new AbortController().signal,
      },
    });
    expect(output).toEqual([
      {
        evidenceId: 'e-1',
        request: {
          query: 'Kafka',
          limit: 3,
          runId: '0f911cbe-9cb5-465f-b9ae-267597d95f37',
        },
      },
    ]);
    expect(search).toHaveBeenCalledTimes(1);
    await expect(gateway.listPrompts('workspace_knowledge')).resolves.toMatchObject({
      prompts: [{ name: 'search-guidance' }],
    });
    const prompt = await gateway.getPrompt('workspace_knowledge', { name: 'search-guidance' });
    expect(prompt.messages[0]?.content).toMatchObject({ type: 'text' });
    await expect(gateway.listResources('workspace_knowledge')).resolves.toMatchObject({
      resources: [
        expect.objectContaining({
          uri: 'agentpress://built-in/workspace_knowledge/capabilities/search',
        }),
        expect.objectContaining({ uri: 'agentpress://built-in/workspace_knowledge/policy' }),
      ],
    });
    await expect(gateway.listResourceTemplates('workspace_knowledge')).resolves.toMatchObject({
      resourceTemplates: [
        expect.objectContaining({
          uriTemplate: 'agentpress://built-in/workspace_knowledge/capabilities/{name}',
        }),
      ],
    });
    const policy = await gateway.readResource('workspace_knowledge', {
      uri: 'agentpress://built-in/workspace_knowledge/policy',
    });
    expect(policy.contents[0]).toMatchObject({ mimeType: 'application/json' });
    await expect(
      gateway.subscribeResource('workspace_knowledge', {
        uri: 'agentpress://built-in/workspace_knowledge/policy',
      }),
    ).resolves.toBeDefined();
    await expect(
      gateway.unsubscribeResource('workspace_knowledge', {
        uri: 'agentpress://built-in/workspace_knowledge/policy',
      }),
    ).resolves.toBeDefined();
    await expect(
      gateway.readResource('workspace_knowledge', {
        uri: 'agentpress://built-in/workspace_knowledge/capabilities/admin',
      }),
    ).rejects.toThrow(/Unknown built-in MCP capability/u);
    await manager.stop('workspace_knowledge');
  });

  it('allocates the bounded source budget only to web research', async () => {
    const search = vi.fn((request: unknown) => Promise.resolve([{ request }]));
    const manager = new McpServerManager();
    for (const definition of createInMemoryBuiltInDefinitions({
      web_research: search,
      workspace_knowledge: search,
      licensed_media: search,
    })) {
      manager.register(definition);
    }
    const gateway = new McpClientGateway(manager);
    const context = {
      runId: '0f911cbe-9cb5-465f-b9ae-267597d95f37',
      toolCallId: 'call-budget',
      signal: new AbortController().signal,
    };

    await gateway.call({
      serverId: 'web_research',
      toolName: 'search',
      arguments: { query: 'Kafka' },
      context,
    });
    await gateway.call({
      serverId: 'workspace_knowledge',
      toolName: 'search',
      arguments: { query: 'Kafka' },
      context,
    });

    expect(search.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ limit: 3 }),
      expect.objectContaining({ limit: 8 }),
    ]);
    await Promise.all([
      manager.stop('web_research'),
      manager.stop('workspace_knowledge'),
      manager.stop('licensed_media'),
    ]);
  });
});

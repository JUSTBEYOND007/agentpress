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
    await manager.stop('workspace_knowledge');
  });
});

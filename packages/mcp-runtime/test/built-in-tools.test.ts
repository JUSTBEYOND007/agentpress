import { CapabilityCatalog, ToolRegistry } from '@agentpress/tool-runtime';
import { describe, expect, it, vi } from 'vitest';

import { registerBuiltInMcpTools } from '../src/index.js';

describe('built-in MCP tools', () => {
  it('registers only three bounded server capabilities', async () => {
    const registry = new ToolRegistry();
    const call = vi.fn(() => Promise.resolve({ results: [], apiKey: 'secret' }));
    registerBuiltInMcpTools(registry, { call });
    expect(registry.list().map(({ toolId }) => toolId)).toEqual([
      'web.search',
      'workspace.search',
      'media.search',
    ]);
    const catalog = new CapabilityCatalog(registry);
    const allowed = new Set(['web.research']);
    expect(
      catalog
        .select('search web', {
          platform: allowed,
          workspace: allowed,
          agent: allowed,
          skill: allowed,
          task: allowed,
        })
        .map(({ toolId }) => toolId),
    ).toEqual(['web.search']);
    const tool = registry.get('web.search', '1.0.0');
    const output = await registry.execute(
      tool,
      { query: 'Kafka' },
      { runId: 'run', toolCallId: 'call' },
    );
    expect(output).toMatchObject({ redactions: 1 });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

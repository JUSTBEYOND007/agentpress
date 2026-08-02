import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import {
  CapabilityCatalog,
  hashToolArguments,
  ToolRegistry,
  ToolRuntimeError,
} from '../src/index.js';

function tool(toolId: string, capability: string) {
  return {
    toolId,
    version: '1.0.0',
    owner: 'test',
    description: `Search ${capability}`,
    capabilities: [capability],
    inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }),
    risk: 'read_only' as const,
    sideEffect: 'No side effect',
    idempotency: 'none' as const,
    timeoutMs: 1_000,
    estimateCost: () => ({}),
    execute: ({ query }: { query: string }) => Promise.resolve({ result: query }),
  };
}

describe('ToolRegistry', () => {
  it('validates both arguments and results and rejects duplicate immutable versions', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('workspace.search', 'workspace.read'));
    expect(() => {
      registry.register(tool('workspace.search', 'workspace.read'));
    }).toThrow(expect.objectContaining({ code: 'duplicate_tool' }));
    const definition = registry.get('workspace.search', '1.0.0');
    await expect(
      registry.execute(definition, { query: 'agent' }, { runId: 'run', toolCallId: 'call' }),
    ).resolves.toEqual({ result: 'agent' });
    await expect(
      registry.execute(definition, { query: 1 }, { runId: 'run', toolCallId: 'call' }),
    ).rejects.toBeInstanceOf(ToolRuntimeError);
  });

  it('selects only the policy intersection and caps tool definitions', () => {
    const registry = new ToolRegistry();
    registry.register(tool('workspace.search', 'workspace.read'));
    registry.register(tool('web.search', 'web.read'));
    const catalog = new CapabilityCatalog(registry);
    const result = catalog.select(
      'workspace search',
      {
        platform: new Set(['workspace.read', 'web.read']),
        workspace: new Set(['workspace.read']),
        agent: new Set(['workspace.read']),
        skill: new Set(['workspace.read']),
        task: new Set(['workspace.read']),
      },
      1,
    );
    expect(result.map(({ toolId }) => toolId)).toEqual(['workspace.search']);
  });

  it('requires every declared capability to survive the policy intersection', () => {
    const registry = new ToolRegistry();
    const definition = tool('workspace.export', 'workspace.read');
    registry.register({ ...definition, capabilities: ['workspace.read', 'workspace.export'] });
    const catalog = new CapabilityCatalog(registry);
    const onlyRead = new Set(['workspace.read']);
    expect(
      catalog.select('export', {
        platform: onlyRead,
        workspace: onlyRead,
        agent: onlyRead,
        skill: onlyRead,
        task: onlyRead,
      }),
    ).toEqual([]);
  });

  it('hashes equivalent JSON arguments identically', () => {
    expect(hashToolArguments({ articleId: 'a', revision: 2 })).toBe(
      hashToolArguments({ revision: 2, articleId: 'a' }),
    );
  });
});

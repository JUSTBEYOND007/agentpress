import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import {
  CapabilityCatalog,
  composeToolGuidance,
  hashToolArguments,
  summarizeToolArguments,
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

  it('rejects schema-invalid output without coercion and preserves the failure path', async () => {
    const registry = new ToolRegistry();
    const definition = tool('workspace.invalid-output', 'workspace.read');
    const invalidOutput = { result: 7 };
    registry.register({ ...definition, execute: () => Promise.resolve(invalidOutput as never) });

    await expect(
      registry.execute(
        registry.get(definition.toolId, definition.version),
        { query: 'agent' },
        { runId: 'run', toolCallId: 'call' },
      ),
    ).rejects.toMatchObject({
      code: 'invalid_output',
      details: { errors: [expect.objectContaining({ path: '/result' })] },
    });
    expect(invalidOutput).toEqual({ result: 7 });
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

  it('exposes descriptive guidance without changing the capability intersection', () => {
    const registry = new ToolRegistry();
    registry.register({
      ...tool('workspace.search', 'workspace.read'),
      guidance: [{ id: 'bounded-query', text: 'Keep queries focused and bounded.' }],
    });
    const onlyRead = new Set(['workspace.read']);
    const selected = new CapabilityCatalog(registry).select('search', {
      platform: onlyRead,
      workspace: onlyRead,
      agent: onlyRead,
      skill: onlyRead,
      task: onlyRead,
    });
    expect(selected[0]).toMatchObject({
      capabilities: ['workspace.read'],
      guidance: [{ id: 'bounded-query', text: 'Keep queries focused and bounded.' }],
    });
    expect(composeToolGuidance(selected)).toBe(
      'Tool-specific guidance:\n- workspace.search@1.0.0 (bounded-query): Keep queries focused and bounded.',
    );
  });

  it('rejects duplicate or empty guidance entries', () => {
    const registry = new ToolRegistry();
    expect(() => {
      registry.register({
        ...tool('workspace.search', 'workspace.read'),
        guidance: [
          { id: 'same', text: 'one' },
          { id: 'same', text: 'two' },
        ],
      });
    }).toThrow('guidance');
  });

  it('keeps evidence provider provenance attached to an immutable tool definition', () => {
    const registry = new ToolRegistry();
    registry.register({
      ...tool('web.search', 'web.read'),
      evidence: { providerRevision: 'anysearch-api-v1+pi-web-access-v0.15.0' },
    });
    expect(registry.get('web.search', '1.0.0').evidence).toEqual({
      providerRevision: 'anysearch-api-v1+pi-web-access-v0.15.0',
    });
    expect(() => {
      registry.register({
        ...tool('web.invalid', 'web.read'),
        evidence: { providerRevision: '  ' },
      });
    }).toThrow(/provider revision/u);
  });

  it('keeps validated MCP transport provenance on the immutable tool definition', () => {
    const registry = new ToolRegistry();
    const transport = {
      kind: 'mcp' as const,
      serverId: 'web_research',
      serverRevision: '1.0.0',
      toolName: 'search',
      toolRevision: '1.0.0',
      adapterRevision: 'agentpress-mcp-adapter-v1',
    };
    registry.register({ ...tool('web.search', 'web.read'), transport });
    expect(registry.get('web.search', '1.0.0').transport).toEqual(transport);

    for (const invalidValue of ['', ' padded ', 'x'.repeat(161)]) {
      expect(() => {
        registry.register({
          ...tool(`web.invalid-${String(invalidValue.length)}`, 'web.read'),
          transport: { ...transport, serverId: invalidValue },
        });
      }).toThrow(/transport provenance/u);
    }
  });

  it('hashes equivalent JSON arguments identically', () => {
    expect(hashToolArguments({ articleId: 'a', revision: 2 })).toBe(
      hashToolArguments({ revision: 2, articleId: 'a' }),
    );
  });

  it('summarizes validated arguments from the declared schema without retaining values', () => {
    const schema = Type.Object(
      {
        query: Type.String(),
        limit: Type.Optional(Type.Integer()),
        filters: Type.Array(Type.String()),
        options: Type.Object({ locale: Type.String() }),
        enabled: Type.Boolean(),
      },
      { additionalProperties: false },
    );
    const summary = summarizeToolArguments(schema, {
      query: 'private research query',
      limit: 3,
      filters: ['private', 'values'],
      options: { locale: 'zh-CN' },
      enabled: true,
    });

    expect(summary).toEqual({
      schemaVersion: 1,
      fieldCount: 5,
      additionalFieldCount: 0,
      fields: [
        {
          name: 'enabled',
          required: true,
          schemaTypes: ['boolean'],
          valueType: 'boolean',
        },
        {
          name: 'filters',
          required: true,
          schemaTypes: ['array'],
          valueType: 'array',
          arrayLength: 2,
        },
        {
          name: 'limit',
          required: false,
          schemaTypes: ['integer'],
          valueType: 'integer',
        },
        {
          name: 'options',
          required: true,
          schemaTypes: ['object'],
          valueType: 'object',
          objectKeyCount: 1,
        },
        {
          name: 'query',
          required: true,
          schemaTypes: ['string'],
          valueType: 'string',
          stringLength: 22,
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('private');
    expect(JSON.stringify(summary)).not.toContain('zh-CN');
  });

  it('counts additional fields without exposing their names', () => {
    const summary = summarizeToolArguments(Type.Object({ query: Type.String() }), {
      query: 'safe shape only',
      'credential-secret-name': 'credential-secret-value',
    });

    expect(summary).toMatchObject({ fieldCount: 2, additionalFieldCount: 1 });
    expect(summary.fields.map(({ name }) => name)).toEqual(['query']);
    expect(JSON.stringify(summary)).not.toContain('credential');
  });
});

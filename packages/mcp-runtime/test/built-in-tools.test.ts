import {
  CapabilityCatalog,
  ToolRegistry,
  type ToolExecutionContext,
} from '@agentpress/tool-runtime';
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
    await expect(
      registry.execute(tool, { query: 'Kafka', limit: 4 }, { runId: 'run', toolCallId: 'call-2' }),
    ).rejects.toThrow();
  });

  it('passes oversized output to the Artifact writer with ToolCall identity', async () => {
    const registry = new ToolRegistry();
    const writeOversizedOutputArtifact = vi.fn(
      (input: { readonly bytes: number; readonly context: ToolExecutionContext }) =>
        Promise.resolve({
          artifactId: 'artifact-1',
          versionId: 'version-1',
          contentHash: 'hash-1',
          bytes: input.bytes,
          uri: 'artifact://artifact-1/versions/1',
        }),
    );
    registerBuiltInMcpTools(
      registry,
      { call: () => Promise.resolve({ text: 'x'.repeat(2_000) }) },
      { maxOutputBytes: 100, writeOversizedOutputArtifact },
    );
    const output = await registry.execute(
      registry.get('workspace.search', '1.0.0'),
      { query: 'large' },
      { runId: 'run-1', taskId: 'task-1', toolCallId: 'call-1' },
    );
    expect(output).toMatchObject({
      value: { artifactId: 'artifact-1' },
      artifact: { versionId: 'version-1' },
    });
    expect(writeOversizedOutputArtifact.mock.calls[0]?.[0].context).toMatchObject({
      runId: 'run-1',
      taskId: 'task-1',
      toolCallId: 'call-1',
    });
  });
});

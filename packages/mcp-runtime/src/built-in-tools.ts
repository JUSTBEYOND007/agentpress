import type { ToolExecutionContext, ToolRegistry } from '@agentpress/tool-runtime';
import { Type } from '@sinclair/typebox';

import type { BuiltInMcpServerId, McpOutputArtifactReference } from './contracts.js';
import { guardMcpOutputWithArtifact } from './output-guard.js';

export type BuiltInMcpGateway = {
  readonly call: (input: {
    readonly serverId: BuiltInMcpServerId;
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly context: ToolExecutionContext;
  }) => Promise<unknown>;
};

export type BuiltInMcpToolOptions = {
  readonly writeOversizedOutputArtifact?: (input: {
    readonly value: unknown;
    readonly bytes: number;
    readonly context: ToolExecutionContext;
  }) => Promise<McpOutputArtifactReference>;
  readonly maxOutputBytes?: number;
};

const searchInput = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 2_000 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);
const guardedOutput = Type.Object({
  value: Type.Unknown(),
  bytes: Type.Integer({ minimum: 0 }),
  redactions: Type.Integer({ minimum: 0 }),
});

export function registerBuiltInMcpTools(
  registry: ToolRegistry,
  gateway: BuiltInMcpGateway,
  options: BuiltInMcpToolOptions = {},
): void {
  const tools = [
    {
      toolId: 'web.search',
      serverId: 'web_research',
      capability: 'web.research',
      description: 'Search public web sources with SSRF protection and return citable evidence',
    },
    {
      toolId: 'workspace.search',
      serverId: 'workspace_knowledge',
      capability: 'workspace.knowledge.read',
      description: 'Search ACL-filtered workspace knowledge and return revision-bound evidence',
    },
    {
      toolId: 'media.search',
      serverId: 'licensed_media',
      capability: 'licensed_media.search',
      description: 'Search licensed media with source and license metadata',
    },
  ] as const;
  for (const tool of tools) {
    registry.register({
      toolId: tool.toolId,
      version: '1.0.0',
      owner: 'agentpress.mcp',
      description: tool.description,
      capabilities: [tool.capability],
      inputSchema: searchInput,
      outputSchema: guardedOutput,
      risk: 'read_only',
      sideEffect: 'Reads a bounded built-in MCP source',
      idempotency: 'none',
      timeoutMs: 30_000,
      estimateCost: () => ({ externalRequests: 1 }),
      execute: async (input, context) =>
        guardMcpOutputWithArtifact(
          await gateway.call({
            serverId: tool.serverId,
            toolName: 'search',
            arguments: input,
            context,
          }),
          undefined,
          {
            ...(options.maxOutputBytes ? { maxBytes: options.maxOutputBytes } : {}),
            ...(options.writeOversizedOutputArtifact
              ? {
                  writeArtifact: (artifact) =>
                    options.writeOversizedOutputArtifact?.({ ...artifact, context }) ??
                    Promise.reject(new Error('MCP output artifact writer is unavailable')),
                }
              : {}),
          },
        ),
    });
  }
}

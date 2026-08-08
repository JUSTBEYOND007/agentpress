import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolRuntimeError } from '@agentpress/tool-runtime';
import type { TSchema } from '@sinclair/typebox';
import deepEqual from 'fast-deep-equal';

import type { BuiltInMcpServerId } from './contracts.js';

type ListedMcpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

export type McpExpectedToolCapability = {
  readonly toolRevision: string;
  readonly inputSchema: TSchema;
};

export type McpToolCapabilityFailureReason =
  | 'tool_missing'
  | 'tool_revision_changed'
  | 'capability_check_failed';

export class McpToolCapabilityError extends ToolRuntimeError {
  public override readonly name = 'McpToolCapabilityError';

  public constructor(
    public readonly serverId: BuiltInMcpServerId,
    public readonly toolName: string,
    public readonly toolRevision: string,
    public readonly reason: McpToolCapabilityFailureReason,
  ) {
    super('tool_not_found', `MCP tool ${toolName} is unavailable for its pinned contract`, {
      serverId,
      toolName,
      toolRevision,
      reason,
    });
  }
}

export async function assertMcpToolCapability(
  client: Client,
  input: {
    readonly serverId: BuiltInMcpServerId;
    readonly toolName: string;
    readonly expected: McpExpectedToolCapability;
  },
): Promise<void> {
  const tools = validateListedMcpTools((await client.listTools()).tools);
  const tool = tools.find(({ name }) => name === input.toolName);
  if (!tool) {
    throw new McpToolCapabilityError(
      input.serverId,
      input.toolName,
      input.expected.toolRevision,
      'tool_missing',
    );
  }
  if (!schemasMatch(input.expected.inputSchema, tool.inputSchema)) {
    throw new McpToolCapabilityError(
      input.serverId,
      input.toolName,
      input.expected.toolRevision,
      'tool_revision_changed',
    );
  }
}

export function validateListedMcpTools(tools: readonly ListedMcpTool[]): readonly ListedMcpTool[] {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool.name.trim() || names.has(tool.name)) {
      throw new Error('MCP tool list contains an empty or duplicate tool name');
    }
    names.add(tool.name);
    if (!isObjectSchema(tool.inputSchema)) {
      throw new Error(`MCP tool ${tool.name} has an invalid input schema`);
    }
  }
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

function schemasMatch(expected: unknown, actual: unknown): boolean {
  return deepEqual(canonicalSchema(expected, true), canonicalSchema(actual, true));
}

function canonicalSchema(value: unknown, root = false): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => canonicalSchema(item));
    return normalized.every((item) => typeof item === 'string')
      ? [...normalized].sort()
      : normalized;
  }
  if (!isRecord(value)) return value;
  const entries = Object.entries(value)
    .filter(([key]) => !['$schema', 'description', 'examples', 'title'].includes(key))
    .flatMap(([key, item]) => {
      if (root && key === 'additionalProperties') return [];
      if (root && key === 'properties' && isRecord(item)) {
        const properties = Object.fromEntries(
          Object.entries(item).filter(([name]) => name !== '_agentpressRunId'),
        );
        return [[key, canonicalSchema(properties)] as const];
      }
      if (root && key === 'required' && Array.isArray(item)) {
        return [
          [key, canonicalSchema(item.filter((name) => name !== '_agentpressRunId'))] as const,
        ];
      }
      return [[key, canonicalSchema(item)] as const];
    });
  return Object.fromEntries(entries);
}

function isObjectSchema(value: unknown): value is { readonly type: 'object' } {
  return isRecord(value) && value.type === 'object';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

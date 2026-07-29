import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { TSchema } from '@sinclair/typebox';

export type BuiltInMcpServerId = 'web_research' | 'workspace_knowledge' | 'licensed_media';
export type McpServerState = 'idle' | 'starting' | 'ready' | 'degraded' | 'stopped';

export type McpServerDefinition = {
  readonly serverId: BuiltInMcpServerId;
  readonly version: string;
  readonly displayName: string;
  readonly createClient: () => Promise<Client>;
};

export type GuardedMcpOutput = {
  readonly value: unknown;
  readonly bytes: number;
  readonly redactions: number;
};

export type McpToolContract = {
  readonly name: string;
  readonly inputSchema: TSchema;
  readonly outputSchema?: TSchema;
};

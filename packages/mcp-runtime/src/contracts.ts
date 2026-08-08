import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  PromptListChangedNotification,
  ResourceListChangedNotification,
  ResourceUpdatedNotification,
  ToolListChangedNotification,
} from '@modelcontextprotocol/sdk/types.js';
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
  readonly source: 'mcp';
  readonly trust: 'untrusted';
  readonly value: unknown;
  readonly bytes: number;
  readonly redactions: number;
  readonly artifact?: McpOutputArtifactReference;
};

export type McpOutputArtifactReference = {
  readonly artifactId: string;
  readonly versionId: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly uri: string;
};

export type McpToolContract = {
  readonly name: string;
  readonly inputSchema: TSchema;
  readonly outputSchema?: TSchema;
};

export type McpNotificationHandlers = {
  readonly resourceUpdated?: (notification: ResourceUpdatedNotification) => void | Promise<void>;
  readonly resourceListChanged?: (
    notification: ResourceListChangedNotification,
  ) => void | Promise<void>;
  readonly promptListChanged?: (
    notification: PromptListChangedNotification,
  ) => void | Promise<void>;
  readonly toolListChanged?: (notification: ToolListChangedNotification) => void | Promise<void>;
};

export type McpTransportAuditEvent = {
  readonly event: 'retry_attempted' | 'reconnected';
  readonly phase: 'before_dispatch';
  readonly reason: 'connect_failure' | 'degraded_client';
  readonly retryOrdinal: number;
  readonly serverId: BuiltInMcpServerId;
  readonly toolName: string;
  readonly runId: string;
  readonly toolCallId: string;
};

export type McpTransportAuditObserver = {
  readonly onTransportEvent: (event: McpTransportAuditEvent) => Promise<void>;
};

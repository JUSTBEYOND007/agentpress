import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { BuiltInMcpServerId, McpServerDefinition } from './contracts.js';

export type StreamableHttpMcpOptions = {
  readonly url: string;
  readonly requestInit?: RequestInit;
  readonly fetch?: StreamableHTTPClientTransportOptions['fetch'];
  readonly sessionId?: string;
  readonly reconnectionOptions?: StreamableHTTPClientTransportOptions['reconnectionOptions'];
};

/**
 * Creates an official MCP SDK transport. The returned transport is deliberately
 * not retried by AgentPress; durable ToolCall recovery owns replay decisions.
 */
export function createStreamableHttpTransport(
  options: StreamableHttpMcpOptions,
): StreamableHTTPClientTransport {
  const url = validateBuiltInMcpUrl(options.url);
  return new StreamableHTTPClientTransport(url, {
    ...(options.requestInit ? { requestInit: options.requestInit } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.reconnectionOptions ? { reconnectionOptions: options.reconnectionOptions } : {}),
  });
}

export async function createStreamableHttpClient(
  options: StreamableHttpMcpOptions,
): Promise<Client> {
  const client = new Client({ name: 'agentpress-mcp-client', version: '1.0.0' });
  // SDK 1.30's optional-property declarations are not exactOptionalPropertyTypes-safe.
  await client.connect(createStreamableHttpTransport(options) as unknown as Transport);
  return client;
}

export function createStreamableHttpDefinition(input: {
  readonly serverId: BuiltInMcpServerId;
  readonly version: string;
  readonly displayName: string;
  readonly transport: StreamableHttpMcpOptions;
}): McpServerDefinition {
  validateBuiltInMcpUrl(input.transport.url);
  return {
    serverId: input.serverId,
    version: input.version,
    displayName: input.displayName,
    createClient: () => createStreamableHttpClient(input.transport),
  };
}

function validateBuiltInMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('MCP Streamable HTTP URL is invalid');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new TypeError('MCP Streamable HTTP requires HTTPS outside localhost');
  }
  if (url.username || url.password) {
    throw new TypeError('MCP Streamable HTTP URL must not contain credentials');
  }
  return url;
}

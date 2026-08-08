import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as z from 'zod/v4';

export type StreamableHttpSearchFixture = {
  readonly url: string;
  readonly callCount: () => number;
  readonly close: () => Promise<void>;
};

export async function startStreamableHttpSearchFixture(): Promise<StreamableHttpSearchFixture> {
  let callCount = 0;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  const mcp = new McpServer({ name: 'agentpress-postgres-fixture', version: '1.0.0' });
  mcp.registerTool(
    'search',
    {
      inputSchema: {
        query: z.string(),
        limit: z.number().int().optional(),
        _agentpressRunId: z.uuid(),
      },
    },
    ({ query, limit, _agentpressRunId }) => {
      callCount += 1;
      const value = [
        {
          evidenceId: 'evidence-real-mcp',
          request: { query, limit, runId: _agentpressRunId },
        },
      ];
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: { value },
      });
    },
  );
  await mcp.connect(transport as unknown as Transport);
  const server = createServer((request, response) => {
    void (async () => {
      const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
      await transport.handleRequest(request, response, body);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP fixture did not bind TCP');
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    callCount: () => callCount,
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return chunks.length === 0
    ? undefined
    : (JSON.parse(Buffer.concat(chunks).toString()) as unknown);
}

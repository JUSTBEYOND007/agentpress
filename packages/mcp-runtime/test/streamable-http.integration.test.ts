import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { describe, expect, it } from 'vitest';

import { createStreamableHttpClient } from '../src/index.js';

describe('MCP Streamable HTTP real fixture', () => {
  it.each([
    { label: 'SSE', enableJsonResponse: false },
    { label: 'JSON', enableJsonResponse: true },
  ])('handles POST $label responses and reuses Mcp-Session-Id', async ({ enableJsonResponse }) => {
    const fixture = await startFixture(enableJsonResponse);
    try {
      const client = await createStreamableHttpClient({ url: fixture.url });
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual(['echo', 'slow']);
      const result = await client.callTool({ name: 'echo', arguments: { value: 'hello' } });
      expect(result.structuredContent).toEqual({ value: 'hello' });
      const sessionId = fixture.transport.sessionId;
      expect(sessionId).toBeDefined();
      expect(
        fixture.requests
          .filter(({ method }) => method === 'POST')
          .slice(1)
          .every(({ session }) => session === sessionId),
      ).toBe(true);
      await client.close();
    } finally {
      await fixture.close();
    }
  });

  it('propagates client cancellation to an in-flight HTTP tool request', async () => {
    const fixture = await startFixture(false);
    try {
      const client = await createStreamableHttpClient({ url: fixture.url });
      const controller = new AbortController();
      const pending = client.callTool({ name: 'slow', arguments: {} }, undefined, {
        signal: controller.signal,
      });
      await fixture.waitForSlowStart();
      controller.abort();
      await expect(pending).rejects.toBeDefined();
      await waitUntil(() => fixture.slowAbortCount() === 1);
      expect(fixture.slowAbortCount()).toBe(1);
      await client.close();
    } finally {
      await fixture.close();
    }
  });

  it('accepts a stateful GET SSE listener with the negotiated session', async () => {
    const fixture = await startFixture(true);
    try {
      const initialized = await fetch(fixture.url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'raw-fixture-client', version: '1.0.0' },
          },
        }),
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get('mcp-session-id') ?? undefined;
      expect(sessionId).toBeDefined();
      const notification = await fetch(fixture.url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-session-id': sessionId ?? '',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(notification.status).toBe(202);
      const controller = new AbortController();
      const stream = await fetch(fixture.url, {
        headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId ?? '' },
        signal: controller.signal,
      });
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      controller.abort();
    } finally {
      await fixture.close();
    }
  });
});

async function startFixture(enableJsonResponse: boolean): Promise<{
  readonly url: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly requests: { readonly method: string; readonly session?: string }[];
  readonly slowAbortCount: () => number;
  readonly waitForSlowStart: () => Promise<void>;
  readonly close: () => Promise<void>;
}> {
  const requests: { method: string; session?: string }[] = [];
  let slowAbortCount = 0;
  let markSlowStarted: (() => void) | undefined;
  const slowStarted = new Promise<void>((resolve) => {
    markSlowStarted = resolve;
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse,
  });
  const mcp = new McpServer({ name: 'agentpress-http-fixture', version: '1.0.0' });
  mcp.registerTool(
    'echo',
    {
      inputSchema: { value: z.string() },
      outputSchema: { value: z.string() },
    },
    ({ value }) =>
      Promise.resolve({
        content: [{ type: 'text', text: value }],
        structuredContent: { value },
      }),
  );
  mcp.registerTool(
    'slow',
    { inputSchema: {} },
    (_arguments, extra) =>
      new Promise((resolve) => {
        markSlowStarted?.();
        const aborted = () => {
          slowAbortCount += 1;
          resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: true });
        };
        if (extra.signal.aborted) aborted();
        else extra.signal.addEventListener('abort', aborted, { once: true });
      }),
  );
  // SDK 1.30 optional callback types are not exactOptionalPropertyTypes-safe.
  await mcp.connect(transport as unknown as Transport);
  const server = createServer((request, response) => {
    void handleRequest(request, response, transport, requests);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP fixture has no TCP address');
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    transport,
    requests,
    slowAbortCount: () => slowAbortCount,
    waitForSlowStart: () => slowStarted,
    close: async () => {
      await transport.close();
      await mcp.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  transport: StreamableHTTPServerTransport,
  requests: { method: string; session?: string }[],
): Promise<void> {
  requests.push({
    method: request.method ?? 'UNKNOWN',
    ...(typeof request.headers['mcp-session-id'] === 'string'
      ? { session: request.headers['mcp-session-id'] }
      : {}),
  });
  try {
    const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
    await transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500);
    response.end(error instanceof Error ? error.message : 'fixture error');
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

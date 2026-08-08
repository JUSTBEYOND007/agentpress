import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '@agentpress/tool-runtime';
import { Type } from '@sinclair/typebox';
import * as z from 'zod/v4';
import { describe, expect, it, vi } from 'vitest';

import {
  createStreamableHttpClient,
  McpCallOutcomeUnknownError,
  McpClientGateway,
  McpServerManager,
} from '../src/index.js';

describe('MCP Streamable HTTP real fixture', () => {
  it.each([
    { label: 'SSE', enableJsonResponse: false },
    { label: 'JSON', enableJsonResponse: true },
  ])('handles POST $label responses and reuses Mcp-Session-Id', async ({ enableJsonResponse }) => {
    const fixture = await startFixture(enableJsonResponse);
    try {
      const client = await createStreamableHttpClient({ url: fixture.url });
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual(['echo', 'slow', 'stubborn']);
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

  it.each([
    { status: 401, authorization: undefined },
    { status: 403, authorization: 'Bearer expired' },
  ] as const)(
    'maps a real HTTP $status initialization rejection without retrying or exposing its body',
    async ({ status, authorization }) => {
      const fixture = await startInitializationFailureFixture({ status });
      const manager = new McpServerManager();
      manager.register({
        serverId: 'web_research',
        version: '1',
        displayName: 'Web',
        createClient: () =>
          createStreamableHttpClient({
            url: fixture.url,
            ...(authorization ? { requestInit: { headers: { authorization } } } : {}),
          }),
      });
      try {
        const error = await new McpClientGateway(manager)
          .call(toolCallInput(`authentication-${String(status)}`, 'ignored'))
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({
          name: 'McpAuthenticationError',
          code: 'tool_authentication_failed',
        });
        expect(String(error)).not.toMatch(/api_key|credential|authorization|generated|secret/u);
        expect(fixture.requestCount()).toBe(1);
        expect(fixture.toolCallCount()).toBe(0);
        expect(fixture.authorization()).toBe(authorization);
        expect(manager.state('web_research')).toBe('degraded');
      } finally {
        await fixture.close();
      }
    },
  );

  it('keeps an unsupported protocol handshake known failed before tool dispatch', async () => {
    const fixture = await startInitializationFailureFixture({ protocolVersion: '1900-01-01' });
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => createStreamableHttpClient({ url: fixture.url }),
    });
    try {
      await expect(
        new McpClientGateway(manager).call(toolCallInput('unsupported-protocol', 'ignored')),
      ).rejects.toMatchObject({
        name: 'McpCallBeforeDispatchError',
        outcome: 'known_failed',
        outcomeReason: 'initialization_failed_before_dispatch',
      });
      expect(fixture.requestCount()).toBe(1);
      expect(fixture.toolCallCount()).toBe(0);
      expect(manager.state('web_research')).toBe('degraded');
    } finally {
      await fixture.close();
    }
  });

  it('proves a real unreachable TCP endpoint fails before tool dispatch after one probe', async () => {
    const endpoint = await closedLocalEndpoint();
    const manager = new McpServerManager();
    let connectionAttempts = 0;
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => {
        connectionAttempts += 1;
        return createStreamableHttpClient({ url: endpoint });
      },
    });
    const onTransportEvent = vi.fn(() => Promise.resolve());

    await expect(
      new McpClientGateway(manager, { onTransportEvent }).call(
        toolCallInput('unreachable-before-dispatch', 'ignored'),
      ),
    ).rejects.toMatchObject({
      name: 'McpCallBeforeDispatchError',
      outcome: 'known_failed',
      outcomeReason: 'connection_unavailable_before_dispatch',
    });
    expect(connectionAttempts).toBe(2);
    expect(onTransportEvent).toHaveBeenCalledTimes(1);
    expect(manager.state('web_research')).toBe('degraded');
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

  it('maps a real HTTP 429 without retaining its response body or degrading the session', async () => {
    const fixture = await startFixture(false);
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => createStreamableHttpClient({ url: fixture.url }),
    });
    const gateway = new McpClientGateway(manager);
    try {
      await expect(
        gateway.call({
          ...toolCallInput('rate-limited', 'ignored'),
          toolName: 'rate_limited',
        }),
      ).rejects.toMatchObject({ name: 'McpRateLimitError', code: 'tool_rate_limited' });
      await expect(
        gateway.call({
          ...toolCallInput('rate-limited-redaction', 'ignored'),
          toolName: 'rate_limited',
        }),
      ).rejects.not.toThrow(/api_key|credential|generated/u);
      expect(fixture.rateLimitedCallCount()).toBe(2);
      expect(manager.state('web_research')).toBe('ready');
      await expect(gateway.call(toolCallInput('after-rate-limit', 'healthy'))).resolves.toBe(
        'healthy',
      );
      await manager.stop('web_research');
    } finally {
      await fixture.close();
    }
  });

  it('redacts a real JSON-RPC missing-tool error and keeps the session healthy', async () => {
    const fixture = await startFixture(false);
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => createStreamableHttpClient({ url: fixture.url }),
    });
    const gateway = new McpClientGateway(manager);
    try {
      const error = await gateway
        .call({
          ...toolCallInput('removed-tool', 'ignored'),
          toolName: 'provider credential=secret removed_tool',
        })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: 'McpProtocolError' });
      expect(String(error)).not.toMatch(/credential|secret|removed_tool/u);
      expect(manager.state('web_research')).toBe('ready');
      await expect(gateway.call(toolCallInput('after-protocol-error', 'healthy'))).resolves.toBe(
        'healthy',
      );
      await manager.stop('web_research');
    } finally {
      await fixture.close();
    }
  });

  it('checks a pinned tool contract through the official SDK before dispatch', async () => {
    const fixture = await startFixture(false);
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => createStreamableHttpClient({ url: fixture.url }),
    });
    const gateway = new McpClientGateway(manager);
    const expectedCapability = {
      toolRevision: '1.0.0',
      inputSchema: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    };
    try {
      await expect(
        gateway.call({
          ...toolCallInput('missing-before-dispatch', 'ignored'),
          toolName: 'removed',
          expectedCapability,
        }),
      ).rejects.toMatchObject({
        name: 'McpToolCapabilityError',
        reason: 'tool_missing',
      });
      await expect(
        gateway.call({
          ...toolCallInput('revision-before-dispatch', 'ignored'),
          expectedCapability: {
            toolRevision: '2.0.0',
            inputSchema: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
          },
        }),
      ).rejects.toMatchObject({
        name: 'McpToolCapabilityError',
        reason: 'tool_revision_changed',
      });
      expect(fixture.echoCallCount()).toBe(0);
      await expect(
        gateway.call({
          ...toolCallInput('valid-pinned-contract', 'healthy'),
          expectedCapability,
        }),
      ).resolves.toBe('healthy');
      expect(fixture.echoCallCount()).toBe(1);
      await manager.stop('web_research');
    } finally {
      await fixture.close();
    }
  });

  it('fences a non-cooperative server timeout and ignores its late completion', async () => {
    const fixture = await startFixture(false);
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => createStreamableHttpClient({ url: fixture.url }),
    });
    const gateway = new McpClientGateway(manager);
    const registry = new ToolRegistry();
    registry.register({
      toolId: 'publication.stubborn_mcp',
      version: '1.0.0',
      owner: 'test',
      description: 'Exercise a non-cooperative MCP write',
      capabilities: ['publication.write'],
      inputSchema: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.String(),
      risk: 'external_write',
      sideEffect: 'Write one remote value',
      idempotency: 'provider_key',
      timeoutMs: 25,
      estimateCost: () => ({}),
      execute: (input, context) =>
        gateway.call({
          serverId: 'web_research',
          toolName: 'stubborn',
          arguments: input,
          context,
        }) as Promise<string>,
    });

    try {
      const pending = registry.execute(
        registry.get('publication.stubborn_mcp', '1.0.0'),
        { value: 'late' },
        {
          runId: 'run-real-streamable-http',
          toolCallId: 'stubborn-timeout',
          idempotencyKey: 'stubborn:1',
        },
      );
      await fixture.waitForStubbornStart();
      await expect(pending).rejects.toMatchObject({
        name: 'ToolExecutionError',
        outcome: 'unknown',
        outcomeReason: 'timeout_after_dispatch',
      });
      await waitUntil(() => fixture.stubbornAbortCount() === 1);
      expect(fixture.stubbornCallCount()).toBe(1);
      expect(fixture.stubbornAbortCount()).toBe(1);
      expect(manager.state('web_research')).toBe('ready');

      fixture.finishStubborn('late');
      await expect(gateway.call(toolCallInput('fresh-after-timeout', 'fresh'))).resolves.toBe(
        'fresh',
      );
      expect(fixture.echoCallCount()).toBe(1);
      expect(fixture.stubbornCallCount()).toBe(1);
      await manager.stop('web_research');
    } finally {
      fixture.finishStubborn('cleanup');
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

  it('reconnects with a fresh client after a server restarts on the same endpoint', async () => {
    const first = await startFixture(false);
    const port = Number(new URL(first.url).port);
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => createStreamableHttpClient({ url: first.url }),
    });
    const gateway = new McpClientGateway(manager);
    await expect(gateway.listTools('web_research')).resolves.toMatchObject([
      { name: 'echo' },
      { name: 'slow' },
      { name: 'stubborn' },
    ]);
    await manager.markDegraded('web_research');
    await first.close();
    const restarted = await startFixture(false, port);
    try {
      await expect(gateway.listTools('web_research')).rejects.toBeDefined();
      await expect(gateway.listTools('web_research')).resolves.toMatchObject([
        { name: 'echo' },
        { name: 'slow' },
        { name: 'stubborn' },
      ]);
      expect(manager.state('web_research')).toBe('ready');
      await manager.stop('web_research');
    } finally {
      await restarted.close();
    }
  });

  it('does not replay an interrupted call and reconnects for the next logical call', async () => {
    const first = await startFixture(false);
    const port = Number(new URL(first.url).port);
    const manager = new McpServerManager();
    manager.register({
      serverId: 'web_research',
      version: '1',
      displayName: 'Web',
      createClient: () => createStreamableHttpClient({ url: first.url }),
    });
    const gateway = new McpClientGateway(manager);
    await expect(gateway.call(toolCallInput('before-restart', 'before'))).resolves.toBe('before');
    expect(first.echoCallCount()).toBe(1);

    await first.close();
    const restarted = await startFixture(false, port);
    try {
      await expect(
        gateway.call(toolCallInput('interrupted-after-restart', 'not-replayed')),
      ).rejects.toBeInstanceOf(McpCallOutcomeUnknownError);
      expect(restarted.echoCallCount()).toBe(0);
      await expect(gateway.call(toolCallInput('fresh-after-restart', 'after'))).resolves.toBe(
        'after',
      );
      expect(restarted.echoCallCount()).toBe(1);
      expect(manager.state('web_research')).toBe('ready');
      await manager.stop('web_research');
    } finally {
      await restarted.close();
    }
  });
});

async function startFixture(
  enableJsonResponse: boolean,
  port = 0,
): Promise<{
  readonly url: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly requests: { readonly method: string; readonly session?: string }[];
  readonly slowAbortCount: () => number;
  readonly stubbornAbortCount: () => number;
  readonly stubbornCallCount: () => number;
  readonly rateLimitedCallCount: () => number;
  readonly echoCallCount: () => number;
  readonly waitForSlowStart: () => Promise<void>;
  readonly waitForStubbornStart: () => Promise<void>;
  readonly finishStubborn: (value: string) => void;
  readonly close: () => Promise<void>;
}> {
  const requests: { method: string; session?: string }[] = [];
  let slowAbortCount = 0;
  let stubbornAbortCount = 0;
  let stubbornCallCount = 0;
  let rateLimitedCallCount = 0;
  let echoCallCount = 0;
  let markSlowStarted: (() => void) | undefined;
  const slowStarted = new Promise<void>((resolve) => {
    markSlowStarted = resolve;
  });
  let markStubbornStarted: (() => void) | undefined;
  const stubbornStarted = new Promise<void>((resolve) => {
    markStubbornStarted = resolve;
  });
  let settleStubborn:
    | ((value: {
        content: { type: 'text'; text: string }[];
        structuredContent: { value: string };
      }) => void)
    | undefined;
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
    ({ value }) => {
      echoCallCount += 1;
      return Promise.resolve({
        content: [{ type: 'text', text: value }],
        structuredContent: { value },
      });
    },
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
  mcp.registerTool(
    'stubborn',
    {
      inputSchema: { value: z.string() },
      outputSchema: { value: z.string() },
    },
    (_arguments, extra) => {
      stubbornCallCount += 1;
      markStubbornStarted?.();
      extra.signal.addEventListener(
        'abort',
        () => {
          stubbornAbortCount += 1;
        },
        { once: true },
      );
      return new Promise((resolve) => {
        settleStubborn = resolve;
      });
    },
  );
  // SDK 1.30 optional callback types are not exactOptionalPropertyTypes-safe.
  await mcp.connect(transport as unknown as Transport);
  const server = createServer((request, response) => {
    void handleRequest(request, response, transport, requests, () => {
      rateLimitedCallCount += 1;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
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
    stubbornAbortCount: () => stubbornAbortCount,
    stubbornCallCount: () => stubbornCallCount,
    rateLimitedCallCount: () => rateLimitedCallCount,
    echoCallCount: () => echoCallCount,
    waitForSlowStart: () => slowStarted,
    waitForStubbornStart: () => stubbornStarted,
    finishStubborn: (value) => {
      settleStubborn?.({
        content: [{ type: 'text', text: value }],
        structuredContent: { value },
      });
    },
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

async function startInitializationFailureFixture(
  mode: { readonly status: 401 | 403 } | { readonly protocolVersion: string },
): Promise<{
  readonly url: string;
  readonly requestCount: () => number;
  readonly toolCallCount: () => number;
  readonly authorization: () => string | undefined;
  readonly close: () => Promise<void>;
}> {
  let requestCount = 0;
  let toolCallCount = 0;
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      requestCount += 1;
      authorization = request.headers.authorization;
      const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
      if (isToolCall(body)) toolCallCount += 1;
      if ('status' in mode) {
        response.writeHead(mode.status, { 'content-type': 'text/plain' });
        response.end('provider api_key=generated authorization=secret credential=generated');
        return;
      }
      const id =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>).id
          : null;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: mode.protocolVersion,
            capabilities: {},
            serverInfo: { name: 'unsupported-protocol', version: '1' },
          },
        }),
      );
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
  if (!address || typeof address === 'string') throw new Error('fixture did not bind TCP');
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    requestCount: () => requestCount,
    toolCallCount: () => toolCallCount,
    authorization: () => authorization,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function closedLocalEndpoint(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind TCP');
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${String(address.port)}/mcp`;
}

function toolCallInput(toolCallId: string, value: string) {
  return {
    serverId: 'web_research' as const,
    toolName: 'echo',
    arguments: { value },
    context: {
      runId: 'run-real-streamable-http',
      toolCallId,
      signal: new AbortController().signal,
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  transport: StreamableHTTPServerTransport,
  requests: { method: string; session?: string }[],
  onRateLimitedCall: () => void,
): Promise<void> {
  requests.push({
    method: request.method ?? 'UNKNOWN',
    ...(typeof request.headers['mcp-session-id'] === 'string'
      ? { session: request.headers['mcp-session-id'] }
      : {}),
  });
  try {
    const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
    if (isRateLimitedToolCall(body)) {
      onRateLimitedCall();
      response.writeHead(429, { 'content-type': 'text/plain' });
      response.end('provider api_key=generated credential=generated');
      return;
    }
    await transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500);
    response.end(error instanceof Error ? error.message : 'fixture error');
  }
}

function isRateLimitedToolCall(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.method !== 'tools/call') return false;
  if (
    typeof request.params !== 'object' ||
    request.params === null ||
    Array.isArray(request.params)
  ) {
    return false;
  }
  return (request.params as Record<string, unknown>).name === 'rate_limited';
}

function isToolCall(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).method === 'tools/call'
  );
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

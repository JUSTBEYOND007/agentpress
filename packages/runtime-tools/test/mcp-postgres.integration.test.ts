import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  PersistentToolBridge,
  RunProjectionService,
  ToolCallService,
  ToolTransportAuditService,
  type DurableRunEvent,
  type LiveRunEvent,
} from '@agentpress/agent-application';
import {
  agentRuns,
  appUsers,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  rootRequests,
  toolCalls,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import {
  BUILT_IN_MCP_ADAPTER_REVISION,
  createStreamableHttpDefinition,
  McpClientGateway,
  McpServerManager,
  registerBuiltInMcpTools,
} from '@agentpress/mcp-runtime';
import { ToolRegistry } from '@agentpress/tool-runtime';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startStreamableHttpSearchFixture,
  type StreamableHttpSearchFixture,
} from './fixtures/streamable-http-search-server.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('real MCP to PostgreSQL ToolCall composition', () => {
  const connection = connectDatabase(connectionString ?? '');
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const published: LiveRunEvent[] = [];
  const manager = new McpServerManager();
  const registry = new ToolRegistry();
  const transportAudit = new ToolTransportAuditService({
    database: connection.db,
    publisher: {
      publish(event) {
        published.push(event);
        return Promise.resolve();
      },
    },
  });
  registerBuiltInMcpTools(
    registry,
    new McpClientGateway(manager, {
      onTransportEvent: (event) => transportAudit.record(event).then(() => undefined),
    }),
  );
  const service = new ToolCallService({
    database: connection.db,
    registry,
    publisher: {
      publish(event) {
        published.push(event);
        return Promise.resolve();
      },
    },
  });
  let fixture: StreamableHttpSearchFixture;

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: userId,
      logtoSubject: `logto|${userId}`,
      displayName: 'MCP Composition User',
    });
    await connection.db.insert(workspaces).values({
      id: workspaceId,
      name: 'MCP Composition Workspace',
    });
    await connection.db.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId,
      title: 'MCP Composition',
    });
    fixture = await startStreamableHttpSearchFixture();
    manager.register(
      createStreamableHttpDefinition({
        serverId: 'web_research',
        version: '1.0.0',
        displayName: 'Web Research',
        transport: { url: fixture.url },
      }),
    );
  });

  afterAll(async () => {
    await manager.stop('web_research');
    await fixture.close();
    await connection.close();
  });

  it('settles and replays one official MCP call without duplicate provider execution', async () => {
    const publishedFrom = published.length;
    const runId = await createRunningRun();
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: service,
    });
    const webSearch = (await bridge.createForRun(runId, ['web.research'])).find(
      (tool) => tool.label === 'web.search',
    );
    const providerToolCallId = randomUUID();

    const first = await webSearch?.execute(
      { query: 'official MCP PostgreSQL composition', limit: 1 },
      { runId, providerToolCallId },
    );
    const replayed = await webSearch?.execute(
      { query: 'official MCP PostgreSQL composition', limit: 1 },
      { runId, providerToolCallId },
    );
    expect(replayed).toEqual(first);
    expect(first).toMatchObject({
      source: 'mcp',
      trust: 'untrusted',
      value: [
        {
          evidenceId: 'evidence-real-mcp',
          request: {
            query: 'official MCP PostgreSQL composition',
            limit: 1,
            runId,
          },
        },
      ],
    });
    expect(fixture.callCount()).toBe(1);

    await expect(
      connection.db
        .select({
          status: toolCalls.status,
          transport: toolCalls.transportProvenance,
          output: toolCalls.output,
        })
        .from(toolCalls)
        .where(eq(toolCalls.runId, runId)),
    ).resolves.toEqual([
      {
        status: 'succeeded',
        transport: {
          kind: 'mcp',
          serverId: 'web_research',
          serverRevision: '1.0.0',
          toolName: 'search',
          toolRevision: '1.0.0',
          adapterRevision: BUILT_IN_MCP_ADAPTER_REVISION,
        },
        output: first,
      },
    ]);

    const durableLive = published
      .slice(publishedFrom)
      .flatMap((event) => (event.durable && event.event.runId === runId ? [event.event] : []));
    const projection = new RunProjectionService(connection.db);
    expect(await projection.listEvents(runId)).toEqual(durableLive.map(durableContract));
    const replay = await projection.get(runId);
    expect(replay?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'tool.succeeded',
          outcome: 'succeeded',
          payload: expect.objectContaining({
            transportProvenance: expect.objectContaining({
              serverId: 'web_research',
              toolName: 'search',
            }) as unknown,
          }) as unknown,
        }),
      ]),
    );
    expect(
      durableLive.filter(({ eventType }) => eventType === 'tool.duplicate_result_ignored'),
    ).toHaveLength(1);
  });

  it('reconnects a stale capability session before one persisted provider execution', async () => {
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: service,
    });
    const warmRunId = await createRunningRun();
    const warmSearch = (await bridge.createForRun(warmRunId, ['web.research'])).find(
      (tool) => tool.label === 'web.search',
    );
    await expect(
      warmSearch?.execute(
        { query: 'warm MCP session', limit: 1 },
        { runId: warmRunId, providerToolCallId: randomUUID() },
      ),
    ).resolves.toBeDefined();

    const port = Number(new URL(fixture.url).port);
    await fixture.close();
    fixture = await startStreamableHttpSearchFixture({ port });

    const interruptedRunId = await createRunningRun();
    const interruptedSearch = (await bridge.createForRun(interruptedRunId, ['web.research'])).find(
      (tool) => tool.label === 'web.search',
    );
    const interruptedProviderCallId = randomUUID();
    const first = await interruptedSearch?.execute(
      { query: 'stale MCP session', limit: 1 },
      { runId: interruptedRunId, providerToolCallId: interruptedProviderCallId },
    );
    const replayed = await interruptedSearch?.execute(
      { query: 'stale MCP session', limit: 1 },
      { runId: interruptedRunId, providerToolCallId: interruptedProviderCallId },
    );
    expect(first).toBeDefined();
    expect(replayed).toEqual(first);
    expect(fixture.callCount()).toBe(1);

    const interruptedRows = await connection.db
      .select({
        status: toolCalls.status,
        failure: toolCalls.failure,
        retryCount: toolCalls.transportRetryCount,
        reconnectCount: toolCalls.transportReconnectCount,
      })
      .from(toolCalls)
      .where(eq(toolCalls.runId, interruptedRunId));
    expect(interruptedRows).toEqual([
      { status: 'succeeded', failure: null, retryCount: 1, reconnectCount: 1 },
    ]);
    const interruptedProjection = await new RunProjectionService(connection.db).get(
      interruptedRunId,
    );
    expect(interruptedProjection?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'tool.succeeded',
          outcome: 'succeeded',
          payload: expect.objectContaining({
            transportRetryCount: 1,
            transportReconnectCount: 1,
          }) as unknown,
        }),
      ]),
    );
    expect(
      interruptedProjection?.parts.filter(({ status }) => status === 'tool.outcome_unknown'),
    ).toEqual([]);
  });

  it('settles a disappeared remote tool as unavailable before provider dispatch', async () => {
    const missingFixture = await startStreamableHttpSearchFixture({
      toolName: 'retired_search',
    });
    const missingManager = new McpServerManager();
    missingManager.register(
      createStreamableHttpDefinition({
        serverId: 'web_research',
        version: '1.0.0',
        displayName: 'Web Research Missing Tool',
        transport: { url: missingFixture.url },
      }),
    );
    const missingRegistry = new ToolRegistry();
    registerBuiltInMcpTools(missingRegistry, new McpClientGateway(missingManager));
    const missingService = new ToolCallService({
      database: connection.db,
      registry: missingRegistry,
      publisher: { publish: () => Promise.resolve() },
    });
    const runId = await createRunningRun();
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry: missingRegistry,
      toolCalls: missingService,
    });
    const webSearch = (await bridge.createForRun(runId, ['web.research'])).find(
      (tool) => tool.label === 'web.search',
    );

    try {
      await expect(
        webSearch?.execute(
          { query: 'missing remote capability', limit: 1 },
          { runId, providerToolCallId: randomUUID() },
        ),
      ).rejects.toMatchObject({ code: 'invalid_tool_state' });
      expect(missingFixture.callCount()).toBe(0);
      await expect(
        connection.db
          .select({ status: toolCalls.status, failure: toolCalls.failure })
          .from(toolCalls)
          .where(eq(toolCalls.runId, runId)),
      ).resolves.toEqual([
        {
          status: 'failed',
          failure: expect.objectContaining({
            code: 'tool_unavailable',
            messageKey: 'tool.failure.unavailable',
            retryable: true,
            visibility: 'protected',
          }) as unknown,
        },
      ]);
    } finally {
      await missingManager.stop('web_research');
      await missingFixture.close();
    }
  });

  async function createRunningRun(): Promise<string> {
    const branchId = randomUUID();
    const messageId = randomUUID();
    const requestId = randomUUID();
    const runId = randomUUID();
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    await connection.db.insert(conversationMessages).values({
      id: messageId,
      branchId,
      role: 'user',
      sequence: 1,
      content: [],
      stable: true,
    });
    await connection.db.insert(rootRequests).values({
      id: requestId,
      branchId,
      messageId,
      requestedByUserId: userId,
      idempotencyKey: randomUUID(),
    });
    await connection.db.insert(agentRuns).values({
      id: runId,
      workspaceId,
      branchId,
      rootRequestId: requestId,
      mode: 'direct',
      status: 'running',
    });
    return runId;
  }
});

function durableContract(event: DurableRunEvent): DurableRunEvent {
  return {
    id: event.id,
    runId: event.runId,
    sequence: event.sequence,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

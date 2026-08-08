import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  PersistentToolBridge,
  RunProjectionService,
  ToolCallService,
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
  createInMemoryBuiltInDefinitions,
  McpClientGateway,
  McpServerManager,
  registerBuiltInMcpTools,
} from '@agentpress/mcp-runtime';
import { ToolRegistry } from '@agentpress/tool-runtime';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('real MCP to PostgreSQL ToolCall composition', () => {
  const connection = connectDatabase(connectionString ?? '');
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const published: LiveRunEvent[] = [];
  const search = vi.fn((request: unknown) =>
    Promise.resolve([{ evidenceId: 'evidence-real-mcp', request }]),
  );
  const manager = new McpServerManager();
  for (const definition of createInMemoryBuiltInDefinitions({
    web_research: search,
    workspace_knowledge: search,
    licensed_media: search,
  })) {
    manager.register(definition);
  }
  const registry = new ToolRegistry();
  registerBuiltInMcpTools(registry, new McpClientGateway(manager));
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
  });

  afterAll(async () => {
    await Promise.all([
      manager.stop('web_research'),
      manager.stop('workspace_knowledge'),
      manager.stop('licensed_media'),
    ]);
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
    expect(search).toHaveBeenCalledTimes(1);

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
          adapterRevision: 'agentpress-mcp-adapter-v1',
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

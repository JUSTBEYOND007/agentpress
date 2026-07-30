import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  agentRuns,
  appUsers,
  approvals,
  checkpoints,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  rootRequests,
  toolCalls,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { ToolExecutionError, ToolRegistry } from '@agentpress/tool-runtime';
import { Type } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DirectRunService,
  PersistentToolBridge,
  ToolCallService,
  type LiveRunEvent,
} from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Tool Call application flow', () => {
  const connection = connectDatabase(connectionString ?? '');
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const published: LiveRunEvent[] = [];
  const registry = new ToolRegistry();
  let externalExecutions = 0;
  registry.register({
    toolId: 'workspace.search',
    version: '1.0.0',
    owner: 'workspace',
    description: 'Search workspace',
    capabilities: ['workspace.read'],
    inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }),
    risk: 'read_only',
    sideEffect: 'No side effect',
    idempotency: 'none',
    timeoutMs: 1_000,
    estimateCost: () => ({}),
    execute: ({ query }) => Promise.resolve({ result: query }),
  });
  registry.register({
    toolId: 'publication.publish',
    version: '1.0.0',
    owner: 'publication',
    description: 'Publish an edition',
    capabilities: ['publication.write'],
    inputSchema: Type.Object({ editionId: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ publicationId: Type.String() }, { additionalProperties: false }),
    risk: 'external_write',
    sideEffect: 'Publish the selected immutable edition',
    idempotency: 'provider_key',
    timeoutMs: 1_000,
    estimateCost: () => ({ credits: 1 }),
    execute: () => {
      externalExecutions += 1;
      throw new ToolExecutionError('Provider response was lost', 'unknown');
    },
  });
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
      displayName: 'Tool User',
    });
    await connection.db.insert(workspaces).values({ id: workspaceId, name: 'Tool Workspace' });
    await connection.db.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId,
      title: 'Tool Calls',
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('executes a validated read-only Tool Call and checkpoints settlement', async () => {
    const runId = await createRunningRun();
    const proposal = await service.propose({
      runId,
      toolId: 'workspace.search',
      toolVersion: '1.0.0',
      arguments: { query: 'AgentPress' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['workspace.read']),
    });
    expect(proposal.status).toBe('proposed');
    await expect(service.execute(proposal.toolCallId)).resolves.toMatchObject({
      status: 'succeeded',
      output: { result: 'AgentPress' },
    });
    await expect(service.execute(proposal.toolCallId)).rejects.toMatchObject({
      code: 'invalid_tool_state',
    });
    const saved = await connection.db
      .select({ reason: checkpoints.reason })
      .from(checkpoints)
      .where(eq(checkpoints.runId, runId));
    expect(saved).toEqual([{ reason: 'tool_settled' }]);
  });

  it('bridges a Pi Runtime tool through the persistent ledger', async () => {
    const runId = await createRunningRun();
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: service,
    });
    const tools = await bridge.createForRun(runId);
    const search = tools.find((tool) => tool.label === 'workspace.search');
    await expect(
      search?.execute({ query: 'durable tool' }, { runId, providerToolCallId: randomUUID() }),
    ).resolves.toEqual({ result: 'durable tool' });
    const rows = await connection.db
      .select({ status: toolCalls.status })
      .from(toolCalls)
      .where(eq(toolCalls.runId, runId));
    expect(rows).toEqual([{ status: 'succeeded' }]);
  });

  it('rejects approval if exact persisted arguments no longer match', async () => {
    const runId = await createRunningRun();
    const proposal = await proposePublish(runId);
    await connection.db
      .update(toolCalls)
      .set({ argumentsHash: 'tampered' })
      .where(eq(toolCalls.id, proposal.toolCallId));

    await expect(
      service.decideApproval({
        toolCallId: proposal.toolCallId,
        decision: 'approved',
        userId,
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
  });

  it('commits expiry before returning an approval error', async () => {
    const runId = await createRunningRun();
    const proposal = await proposePublish(runId);
    await connection.db
      .update(approvals)
      .set({ expiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(approvals.toolCallId, proposal.toolCallId));

    await expect(
      service.decideApproval({
        toolCallId: proposal.toolCallId,
        decision: 'approved',
        userId,
      }),
    ).rejects.toMatchObject({ code: 'approval_expired' });
    const rows = await connection.db
      .select({ decision: approvals.decision })
      .from(approvals)
      .where(eq(approvals.toolCallId, proposal.toolCallId));
    expect(rows[0]?.decision).toBe('expired');
  });

  it('never retries an external Tool Call with Unknown Outcome', async () => {
    const runId = await createRunningRun();
    const proposal = await proposePublish(runId);
    await service.decideApproval({
      toolCallId: proposal.toolCallId,
      decision: 'approved',
      userId,
    });
    await expect(service.execute(proposal.toolCallId)).resolves.toMatchObject({
      status: 'outcome_unknown',
    });
    await expect(service.execute(proposal.toolCallId)).rejects.toMatchObject({
      code: 'invalid_tool_state',
    });
    expect(externalExecutions).toBe(1);
    const rows = await connection.db
      .select({ status: toolCalls.status })
      .from(toolCalls)
      .where(eq(toolCalls.id, proposal.toolCallId));
    expect(rows[0]?.status).toBe('outcome_unknown');
  });

  it('settles an executing external write as Unknown Outcome during recovery', async () => {
    const runId = await createRunningRun();
    const toolCallId = randomUUID();
    await connection.db.insert(toolCalls).values({
      id: toolCallId,
      runId,
      toolId: 'publication.publish',
      toolVersion: '1.0.0',
      arguments: { editionId: randomUUID() },
      argumentsHash: 'already-dispatched',
      risk: 'external_write',
      sideEffect: 'Publish the selected immutable edition',
      idempotencyKey: `publish:${randomUUID()}`,
      status: 'executing',
    });
    const runs = new DirectRunService({
      database: connection.db,
      publisher: {
        publish(event) {
          published.push(event);
          return Promise.resolve();
        },
      },
      runtimeFactory: {
        create() {
          throw new Error('Recovery test must not invoke the runtime');
        },
      },
      systemPrompt: 'You are AgentPress.',
    });

    await expect(runs.prepareRecovery(runId)).resolves.toBe(true);
    const rows = await connection.db
      .select({ status: toolCalls.status })
      .from(toolCalls)
      .where(eq(toolCalls.id, toolCallId));
    expect(rows[0]?.status).toBe('outcome_unknown');
  });

  async function proposePublish(runId: string) {
    return service.propose({
      runId,
      toolId: 'publication.publish',
      toolVersion: '1.0.0',
      arguments: { editionId: randomUUID() },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['publication.write']),
      idempotencyKey: `publish:${randomUUID()}`,
    });
  }

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

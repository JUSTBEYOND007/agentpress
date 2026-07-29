import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentRuns,
  appendRunEvent,
  appUsers,
  claimOutboxMessages,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  enqueueOutboxMessage,
  inboxMessages,
  markOutboxMessagePublished,
  decideMemoryCandidate,
  listAcceptedMemory,
  proposeMemoryCandidate,
  processInboxMessage,
  rootRequests,
  runEvents,
  workspaces,
  workspaceMembers,
} from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('PostgreSQL runtime persistence', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
    branch: randomUUID(),
    message: randomUUID(),
    request: randomUUID(),
    run: randomUUID(),
  };

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Integration User',
    });
    await connection.db.insert(workspaces).values({ id: ids.workspace, name: 'Integration' });
    await connection.db
      .insert(workspaceMembers)
      .values({ userId: ids.user, workspaceId: ids.workspace, role: 'owner' });
    await connection.db
      .insert(conversations)
      .values({ id: ids.conversation, workspaceId: ids.workspace, title: 'Test' });
    await connection.db
      .insert(conversationBranches)
      .values({ id: ids.branch, conversationId: ids.conversation });
    await connection.db.insert(conversationMessages).values({
      id: ids.message,
      branchId: ids.branch,
      role: 'user',
      sequence: 1,
      content: [{ type: 'text', text: 'test' }],
      stable: true,
    });
    await connection.db.insert(rootRequests).values({
      id: ids.request,
      branchId: ids.branch,
      messageId: ids.message,
      idempotencyKey: `request:${ids.request}`,
    });
    await connection.db.insert(agentRuns).values({
      id: ids.run,
      workspaceId: ids.workspace,
      branchId: ids.branch,
      rootRequestId: ids.request,
      mode: 'planned',
      status: 'queued',
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('deduplicates inbox processing in the same transaction as domain work', async () => {
    const envelope = {
      consumerGroup: `integration-worker-${ids.run}`,
      messageId: randomUUID(),
      topic: 'agent.run.commands',
      partition: 0,
      offset: 1,
      payloadHash: 'sha256:message',
    };
    let calls = 0;
    const handler = (): Promise<void> => {
      calls += 1;
      return Promise.resolve();
    };

    expect(await processInboxMessage(connection.db, envelope, handler)).toBe('processed');
    expect(await processInboxMessage(connection.db, envelope, handler)).toBe('duplicate');
    expect(calls).toBe(1);
    expect(
      await connection.db
        .select()
        .from(inboxMessages)
        .where(eq(inboxMessages.messageId, envelope.messageId)),
    ).toHaveLength(1);
  });

  it('enforces at most one active Run on a Conversation branch', async () => {
    const messageId = randomUUID();
    const requestId = randomUUID();
    await connection.db.insert(conversationMessages).values({
      id: messageId,
      branchId: ids.branch,
      role: 'user',
      sequence: 2,
      content: [{ type: 'text', text: 'second run' }],
      stable: true,
    });
    await connection.db.insert(rootRequests).values({
      id: requestId,
      branchId: ids.branch,
      messageId,
      idempotencyKey: `request:${requestId}`,
    });

    await expect(
      connection.db.insert(agentRuns).values({
        id: randomUUID(),
        workspaceId: ids.workspace,
        branchId: ids.branch,
        rootRequestId: requestId,
        mode: 'direct',
        status: 'queued',
      }),
    ).rejects.toMatchObject({
      cause: {
        code: '23505',
        constraint: 'agent_runs_one_active_per_branch_unique',
      },
    });
  });

  it('claims, publishes and sequences durable events without duplicates', async () => {
    const outboxId = randomUUID();
    await connection.db.transaction(async (transaction) => {
      await enqueueOutboxMessage(transaction, {
        id: outboxId,
        aggregateType: 'AgentRun',
        aggregateId: ids.run,
        topic: 'agent.run.events',
        messageKey: ids.run,
        payload: { type: 'run.queued' },
        occurredAt: new Date(),
      });
    });

    const claimed = await claimOutboxMessages(connection.db, 'worker-1', 10);
    expect(claimed.map(({ id }) => id)).toContain(outboxId);
    expect(await markOutboxMessagePublished(connection.db, outboxId, 'worker-1', new Date())).toBe(
      true,
    );
    expect(await claimOutboxMessages(connection.db, 'worker-2', 10)).toHaveLength(0);
    const events = await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        connection.db.transaction((transaction) =>
          appendRunEvent(transaction, {
            id: randomUUID(),
            runId: ids.run,
            eventType: 'run.tested',
            payload: { index },
          }),
        ),
      ),
    );
    expect(events.map(({ sequence }) => sequence).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(
      await connection.db.select().from(runEvents).where(eq(runEvents.runId, ids.run)),
    ).toHaveLength(8);
  });

  it('persists confirmed memory and isolates retrieval by workspace and user', async () => {
    const first = await proposeMemoryCandidate(connection.db, {
      id: randomUUID(),
      workspaceId: ids.workspace,
      userId: ids.user,
      subject: 'writing_style',
      value: 'concise',
      valueHash: 'sha256:concise',
      confidenceBps: 9000,
    });
    expect(
      await listAcceptedMemory(connection.db, { workspaceId: ids.workspace, userId: ids.user }),
    ).toEqual([]);
    expect(
      await decideMemoryCandidate(connection.db, {
        id: first.id,
        workspaceId: ids.workspace,
        userId: ids.user,
        decision: 'accepted',
      }),
    ).toMatchObject({ status: 'accepted' });
    const replacement = await proposeMemoryCandidate(connection.db, {
      id: randomUUID(),
      workspaceId: ids.workspace,
      userId: ids.user,
      subject: 'writing_style',
      value: 'detailed',
      valueHash: 'sha256:detailed',
      confidenceBps: 8500,
      supersedesId: first.id,
    });
    await decideMemoryCandidate(connection.db, {
      id: replacement.id,
      workspaceId: ids.workspace,
      userId: ids.user,
      decision: 'accepted',
    });
    expect(
      await listAcceptedMemory(connection.db, { workspaceId: ids.workspace, userId: ids.user }),
    ).toHaveLength(1);
    expect(
      await listAcceptedMemory(connection.db, { workspaceId: randomUUID(), userId: ids.user }),
    ).toEqual([]);
  });
});

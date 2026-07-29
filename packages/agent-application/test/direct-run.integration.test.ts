import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PiRuntimeAdapter } from '@agentpress/agent-runtime';
import {
  agentRuns,
  appUsers,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  rootRequests,
  runEvents,
  workspaces,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DirectRunService, type LiveRunEvent, type RunEventPublisher } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Direct Run application flow', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
    branch: randomUUID(),
  };
  const published: LiveRunEvent[] = [];
  const publisher: RunEventPublisher = {
    publish(event) {
      published.push(event);
      return Promise.resolve();
    },
  };
  const runtime = PiRuntimeAdapter.forTests({
    responses: ['第一轮稳定回答。', '第二轮稳定回答。'],
  });
  const service = new DirectRunService({
    database: connection.db,
    publisher,
    runtimeFactory: { create: () => runtime },
    systemPrompt: 'You are AgentPress.',
  });

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Direct Run User',
    });
    await connection.db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Direct Run Workspace',
    });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Direct Run',
    });
    await connection.db.insert(conversationBranches).values({
      id: ids.branch,
      conversationId: ids.conversation,
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('deduplicates creation and restores stable history for the next turn', async () => {
    const firstInput = {
      conversationId: ids.conversation,
      branchId: ids.branch,
      prompt: '第一问',
      idempotencyKey: randomUUID(),
    };
    const first = await service.create(firstInput);
    const duplicate = await service.create(firstInput);

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ ...first, created: false });
    await expect(service.execute(first.runId)).resolves.toMatchObject({ status: 'completed' });

    const second = await service.create({
      conversationId: ids.conversation,
      branchId: ids.branch,
      prompt: '第二问',
      idempotencyKey: randomUUID(),
    });
    await expect(service.execute(second.runId)).resolves.toMatchObject({ status: 'completed' });

    const messages = await connection.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.branchId, ids.branch));
    expect(messages).toHaveLength(4);
    expect(messages.every(({ stable }) => stable)).toBe(true);
    expect(
      await connection.db.select().from(rootRequests).where(eq(rootRequests.branchId, ids.branch)),
    ).toHaveLength(2);
    expect(
      await connection.db.select().from(runEvents).where(eq(runEvents.runId, second.runId)),
    ).toHaveLength(4);
    expect(published.some((event) => !event.durable)).toBe(true);
  });

  it('persists cancellation before aborting Pi and reaches a terminal state', async () => {
    const cancellationBranch = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: cancellationBranch,
      conversationId: ids.conversation,
    });
    const controller = new AbortController();
    const serviceReference: { current?: DirectRunService } = {};
    let cancellationRequested = false;
    const cancellationPublisher: RunEventPublisher = {
      async publish(event) {
        if (!event.durable && event.event.type === 'content.delta' && !cancellationRequested) {
          cancellationRequested = true;
          await serviceReference.current?.requestCancellation(event.runId);
          controller.abort();
        }
      },
    };
    const cancellationService = new DirectRunService({
      database: connection.db,
      publisher: cancellationPublisher,
      runtimeFactory: {
        create: () =>
          PiRuntimeAdapter.forTests({
            responses: ['不会完整生成的回答。'],
            tokensPerSecond: 1,
          }),
      },
      systemPrompt: 'You are AgentPress.',
    });
    serviceReference.current = cancellationService;
    const run = await cancellationService.create({
      conversationId: ids.conversation,
      branchId: cancellationBranch,
      prompt: '开始取消测试',
      idempotencyKey: randomUUID(),
    });

    await expect(cancellationService.execute(run.runId, controller.signal)).resolves.toMatchObject({
      status: 'cancelled',
    });
    const rows = await connection.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    expect(rows[0]?.status).toBe('cancelled');
  });
});

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PiRuntimeAdapter, type RuntimeAssistantMessage } from '@agentpress/agent-runtime';
import {
  agentRuns,
  appUsers,
  checkpoints,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  isDatabaseConnectionFailure,
  runEvents,
  type AgentPressDatabase,
  type DatabaseTransaction,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DirectRunService,
  RunSettlementService,
  type LiveRunEvent,
  type RunEventPublisher,
} from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Run settlement database fault boundaries', () => {
  const connection = connectDatabase(connectionString ?? '');
  const controller = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
  };
  const published: LiveRunEvent[] = [];
  const publisher: RunEventPublisher = {
    publish(event) {
      published.push(event);
      return Promise.resolve();
    },
  };
  const creation = new DirectRunService({
    database: connection.db,
    publisher,
    runtimeFactory: { create: () => PiRuntimeAdapter.forTests({ responses: [] }) },
    systemPrompt: 'You are AgentPress.',
  });

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Settlement Fault User',
    });
    await connection.db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Settlement Fault Workspace',
    });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Settlement Faults',
    });
  });

  afterAll(async () => {
    await Promise.all([connection.close(), controller.close()]);
  });

  it('rolls back every settlement fact when PostgreSQL disconnects before commit', async () => {
    const run = await createRunningRun('Disconnect before commit');
    const before = await settlementFactCounts(run.runId);
    const faultDatabase = overrideTransaction(connection.db, async (callback) =>
      connection.db.transaction(async (transaction) => {
        const value = await callback(transaction);
        const backend = await transaction.execute<{ readonly pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        const pid = backend.rows[0]?.pid;
        if (!pid) throw new Error('Settlement transaction has no PostgreSQL backend pid');
        await controller.db.execute(sql`select pg_terminate_backend(${pid})`);
        return value;
      }),
    );
    const settlement = settlementService(faultDatabase);
    let failure: unknown;
    try {
      await settlement.settle(run.branchId, run.runId, completedResult(run.runId));
    } catch (error) {
      failure = error;
    }
    expect(isDatabaseConnectionFailure(failure)).toBe(true);

    await expect(runStatus(run.runId)).resolves.toBe('running');
    await expect(settlementFactCounts(run.runId)).resolves.toEqual(before);
    await expect(
      settlementService(connection.db).settle(run.branchId, run.runId, completedResult(run.runId)),
    ).resolves.toEqual({ runId: run.runId, status: 'completed' });
    await expect(settlementFactCounts(run.runId)).resolves.toEqual({
      assistantMessages: before.assistantMessages + 1,
      settlementCheckpoints: before.settlementCheckpoints + 1,
      terminalEvents: before.terminalEvents + 1,
    });
  });

  it('reconciles committed PostgreSQL facts when the commit acknowledgement is lost', async () => {
    const run = await createRunningRun('Disconnect after commit');
    const before = await settlementFactCounts(run.runId);
    let loseAcknowledgement = true;
    const faultDatabase = overrideTransaction(connection.db, async (callback) => {
      const value = await connection.db.transaction(callback);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw Object.assign(new Error('private commit acknowledgement detail'), {
          code: 'ECONNRESET',
        });
      }
      return value;
    });
    const publishedBefore = published.length;

    await expect(
      settlementService(faultDatabase).settle(run.branchId, run.runId, completedResult(run.runId)),
    ).resolves.toEqual({ runId: run.runId, status: 'completed' });

    await expect(runStatus(run.runId)).resolves.toBe('completed');
    await expect(settlementFactCounts(run.runId)).resolves.toEqual({
      assistantMessages: before.assistantMessages + 1,
      settlementCheckpoints: before.settlementCheckpoints + 1,
      terminalEvents: before.terminalEvents + 1,
    });
    const reconciledEvents = published
      .slice(publishedBefore)
      .filter((event): event is Extract<LiveRunEvent, { readonly durable: true }> => event.durable)
      .map(({ event }) => event.eventType);
    expect(reconciledEvents).toEqual(['message.completed', 'run.completed']);
  });

  async function createRunningRun(prompt: string) {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const run = await creation.create({
      conversationId: ids.conversation,
      branchId,
      userId: ids.user,
      prompt,
      idempotencyKey: randomUUID(),
    });
    await connection.db
      .update(agentRuns)
      .set({ status: 'running' })
      .where(eq(agentRuns.id, run.runId));
    return { ...run, branchId };
  }

  function settlementService(database: AgentPressDatabase): RunSettlementService {
    return new RunSettlementService({
      database,
      publisher,
      createId: randomUUID,
      now: () => new Date(),
      compactConversation: () => Promise.resolve({ status: 'not_needed' }),
      activateNextFollowUp: () => Promise.resolve(),
    });
  }

  async function settlementFactCounts(runId: string) {
    const [messages, settledCheckpoints, terminal] = await Promise.all([
      connection.db
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(
          and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')),
        ),
      connection.db
        .select({ id: checkpoints.id })
        .from(checkpoints)
        .where(and(eq(checkpoints.runId, runId), eq(checkpoints.reason, 'run_settled'))),
      connection.db
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.eventType, 'run.completed'))),
    ]);
    return {
      assistantMessages: messages.length,
      settlementCheckpoints: settledCheckpoints.length,
      terminalEvents: terminal.length,
    };
  }

  async function runStatus(runId: string): Promise<string | undefined> {
    const rows = await connection.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    return rows[0]?.status;
  }
});

function completedResult(runId: string) {
  return {
    status: 'completed' as const,
    messages: [assistantMessage(runId)],
  };
}

function assistantMessage(content: string): RuntimeAssistantMessage {
  return {
    role: 'assistant',
    content,
    blocks: [{ type: 'text', text: content }],
    provider: 'test',
    model: 'test',
    stopReason: 'stop',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      costUsd: 0,
    },
    timestamp: Date.now(),
  };
}

type TransactionOverride = <T>(
  callback: (transaction: DatabaseTransaction) => Promise<T>,
) => Promise<T>;

function overrideTransaction(
  database: AgentPressDatabase,
  transaction: TransactionOverride,
): AgentPressDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'transaction') return transaction;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return value.bind(target) as unknown;
    },
  });
}

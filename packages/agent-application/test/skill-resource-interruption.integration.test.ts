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
  runContextPacks,
  runSkillBindings,
  skillRevisionResources,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextGovernanceService, DirectRunService } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Skill resource read interruption', () => {
  const connection = connectDatabase(connectionString ?? '');
  const timedConnection = connectDatabase(withStatementTimeout(connectionString ?? '', 100));
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
    branch: randomUUID(),
  };

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Skill resource interruption fixture',
    });
    await connection.db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Skill resource interruption',
    });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Interrupted Skill resource',
    });
    await connection.db.insert(conversationBranches).values({
      id: ids.branch,
      conversationId: ids.conversation,
    });
  });

  afterAll(async () => {
    await Promise.all([timedConnection.close(), connection.close()]);
  });

  it('rolls back every Run fact and permits retry after a resource read timeout', async () => {
    const skillId = `interrupted-resource-${randomUUID()}`;
    const version = '1.0.0';
    await new ContextGovernanceService(connection.db).createSkill(
      ids.workspace,
      `---\nid: ${skillId}\nversion: ${version}\ndescription: Interrupted resource fixture\nresources:\n  - references/source.md\n---\nUse the frozen resource.`,
      [
        {
          path: 'references/source.md',
          content: 'RESOURCE_READ_SUCCEEDED_AFTER_RETRY',
          fileType: 'file',
        },
      ],
    );
    const idempotencyKey = randomUUID();
    const timedService = service(timedConnection.db);
    const lockReady = deferred<boolean>();
    const releaseLock = deferred<boolean>();
    const lock = connection.db.transaction(async (transaction) => {
      await transaction.execute(sql`lock table ${skillRevisionResources} in access exclusive mode`);
      lockReady.resolve(true);
      await releaseLock.promise;
    });
    await lockReady.promise;
    try {
      const interrupted = await timedService
        .create({
          conversationId: ids.conversation,
          branchId: ids.branch,
          userId: ids.user,
          prompt: 'Use the resource after an interrupted read.',
          idempotencyKey,
          skills: [{ skillId, version }],
        })
        .catch((error: unknown) => error);
      expect(interrupted).toMatchObject({
        cause: { code: '57014', message: expect.stringMatching(/statement timeout/u) as unknown },
      });
    } finally {
      releaseLock.resolve(true);
      await lock;
    }

    const [messages, requests, runs, packs, bindings] = await Promise.all([
      connection.db
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(eq(conversationMessages.branchId, ids.branch)),
      connection.db
        .select({ id: rootRequests.id })
        .from(rootRequests)
        .where(eq(rootRequests.branchId, ids.branch)),
      connection.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.branchId, ids.branch)),
      connection.db
        .select({ id: runContextPacks.id })
        .from(runContextPacks)
        .innerJoin(agentRuns, eq(agentRuns.id, runContextPacks.runId))
        .where(eq(agentRuns.branchId, ids.branch)),
      connection.db
        .select({ runId: runSkillBindings.runId })
        .from(runSkillBindings)
        .innerJoin(agentRuns, eq(agentRuns.id, runSkillBindings.runId))
        .where(eq(agentRuns.branchId, ids.branch)),
    ]);
    expect({ messages, requests, runs, packs, bindings }).toEqual({
      messages: [],
      requests: [],
      runs: [],
      packs: [],
      bindings: [],
    });

    const retried = await service(connection.db).create({
      conversationId: ids.conversation,
      branchId: ids.branch,
      userId: ids.user,
      prompt: 'Use the resource after an interrupted read.',
      idempotencyKey,
      skills: [{ skillId, version }],
    });
    const context = await connection.db
      .select({ content: runContextPacks.content })
      .from(runContextPacks)
      .where(eq(runContextPacks.runId, retried.runId));
    expect(context[0]?.content).toContain('RESOURCE_READ_SUCCEEDED_AFTER_RETRY');
  });

  function service(database: typeof connection.db): DirectRunService {
    return new DirectRunService({
      database,
      publisher: { publish: () => Promise.resolve() },
      runtimeFactory: { create: () => PiRuntimeAdapter.forTests({ responses: [] }) },
      systemPrompt: 'You are AgentPress.',
      dispatchCommands: false,
    });
  }
});

function withStatementTimeout(connection: string, timeoutMs: number): string {
  const url = new URL(connection);
  url.searchParams.set('options', `-c statement_timeout=${String(timeoutMs)}`);
  return url.toString();
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

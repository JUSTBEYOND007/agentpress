import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PiRuntimeAdapter } from '@agentpress/agent-runtime';
import {
  appendRunEvent,
  appUsers,
  connectDatabase,
  conversationBranches,
  conversations,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DirectRunService,
  RunProjectionService,
  toDurableEvent,
  type RunEventPublisher,
} from '../src/index.js';
import { projectRunParts } from '../src/run-projection.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Activity outcome PostgreSQL replay', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
  };
  const publisher: RunEventPublisher = { publish: () => Promise.resolve() };
  const creation = new DirectRunService({
    database: connection.db,
    publisher,
    runtimeFactory: { create: () => PiRuntimeAdapter.forTests({ responses: [] }) },
    systemPrompt: 'You are AgentPress.',
    dispatchCommands: false,
  });

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Activity outcome fixture',
    });
    await connection.db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Activity outcome fixture',
    });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Activity outcomes',
    });
  });

  afterAll(async () => connection.close());

  it('keeps every typed terminal outcome identical in live projection and replay', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const run = await creation.create({
      conversationId: ids.conversation,
      branchId,
      userId: ids.user,
      prompt: 'Project the terminal activity matrix.',
      idempotencyKey: randomUUID(),
    });
    const facts = [
      taskFact('succeeded', 'task-succeeded'),
      taskFact('degraded', 'task-degraded'),
      taskFact('failed', 'task-failed'),
      taskFact('cancelled', 'task-cancelled'),
      taskFact('timed_out', 'task-timed-out'),
      taskFact('interrupted', 'task-interrupted'),
      taskFact('stale', 'task-stale'),
      {
        eventType: 'tool.outcome_unknown',
        payload: { toolCallId: 'tool-unknown', reason: 'connection_lost_after_dispatch' },
      },
      taskFact('succeeded', 'task-timed-out'),
    ] as const;
    const liveEvents = await connection.db.transaction(async (transaction) => {
      const appended = [];
      for (const fact of facts) {
        appended.push(
          toDurableEvent(
            await appendRunEvent(transaction, {
              id: randomUUID(),
              runId: run.runId,
              eventType: fact.eventType,
              payload: fact.payload,
            }),
          ),
        );
      }
      return appended;
    });
    const liveParts = projectRunParts(liveEvents);
    const liveEventIds = new Set(liveEvents.map(({ id }) => id));
    const replayEvents = (
      await new RunProjectionService(connection.db).listEvents(run.runId)
    ).filter(({ id }) => liveEventIds.has(id));
    const replayParts = projectRunParts(replayEvents);

    expect(replayParts).toEqual(liveParts);
    expect(liveParts.map(({ outcome }) => outcome)).toEqual([
      'succeeded',
      'degraded',
      'failed',
      'cancelled',
      'timed_out',
      'interrupted',
      'stale',
      'outcome_unknown',
    ]);
    expect(liveParts.map(({ correlationId }) => correlationId)).toEqual([
      'task:task-succeeded:attempt:1',
      'task:task-degraded:attempt:1',
      'task:task-failed:attempt:1',
      'task:task-cancelled:attempt:1',
      'task:task-timed-out:attempt:1',
      'task:task-interrupted:attempt:1',
      'task:task-stale:attempt:1',
      'tool:tool-unknown',
    ]);
    expect(
      liveParts.find(({ correlationId }) => correlationId?.includes('timed-out')),
    ).toMatchObject({ status: 'task.timed_out', outcome: 'timed_out' });
  });
});

function taskFact(status: string, taskId: string) {
  return {
    eventType: `task.${status}`,
    payload: { taskId, attempt: 1 },
  };
}

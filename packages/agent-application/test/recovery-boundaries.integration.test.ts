import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  PiRuntimeAdapter,
  RUNTIME_CURRENT_TURN_VERSION,
  type RuntimeCurrentTurn,
} from '@agentpress/agent-runtime';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import {
  agentRuns,
  agentTasks,
  appUsers,
  artifacts,
  artifactVersions,
  connectDatabase,
  conversationBranches,
  conversations,
  executionPlans,
  planRevisions,
  taskResults,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DirectRunService,
  PlannedRunStore,
  SpecialistResultStore,
  type PlannedTaskSpec,
  type RunEventPublisher,
} from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Recovery fault boundaries', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
  };
  const publisher: RunEventPublisher = { publish: () => Promise.resolve() };

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Recovery Boundary User',
    });
    await connection.db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Recovery Boundary Workspace',
    });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Recovery Boundaries',
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('times out a real Pi provider during recovery without replacing preserved Artifacts', async () => {
    const provider = await startHangingOpenAiProvider();
    try {
      const branchId = randomUUID();
      await connection.db.insert(conversationBranches).values({
        id: branchId,
        conversationId: ids.conversation,
      });
      const main = PiRuntimeAdapter.forTests({
        responses: [
          fauxAssistantMessage(
            [
              fauxToolCall('run_complete', {
                answer: 'Recovered with the preserved research brief.',
                artifactIds: [],
                evidenceIds: [],
              }),
            ],
            { stopReason: 'toolUse' },
          ),
        ],
      });
      const hangingWriter = PiRuntimeAdapter.forOpenAICompatible({
        providerId: 'recovery-timeout-provider',
        providerName: 'Recovery timeout provider',
        apiKey: 'test-key',
        baseUrl: provider.baseUrl,
        modelId: 'hanging-writer',
        acceptsStrictTools: true,
        enforcesStrictTools: true,
      });
      const service = new DirectRunService({
        database: connection.db,
        publisher,
        runtimeFactory: { create: (purpose) => (purpose === 'writer' ? hangingWriter : main) },
        systemPrompt: 'You are AgentPress.',
        taskTimeoutMs: 1_000,
      });
      const run = await service.create({
        conversationId: ids.conversation,
        branchId,
        userId: ids.user,
        prompt: 'Recover the interrupted writing plan.',
        idempotencyKey: randomUUID(),
      });
      const planId = randomUUID();
      const revisionId = randomUUID();
      const researchTask = task('research', 'researcher', 'required');
      const writerTask = task('writer', 'writer', 'optional', [researchTask.id]);
      const turn = currentTurn('Recover the interrupted writing plan.');
      const store = new PlannedRunStore({
        database: connection.db,
        publisher,
        createId: randomUUID,
        now: () => new Date(),
      });
      await connection.db.transaction(async (transaction) => {
        await transaction.insert(executionPlans).values({ id: planId, runId: run.runId });
        await transaction.insert(planRevisions).values({
          id: revisionId,
          planId,
          revisionNumber: 1,
          reason: 'initial_plan',
          summary: 'Recover a partially completed plan',
        });
        await store.persistRevisionTasks(
          transaction,
          run.runId,
          revisionId,
          [researchTask, writerTask],
          turn,
        );
        await transaction
          .update(agentRuns)
          .set({ mode: 'planned', status: 'running', activePlanRevisionId: revisionId })
          .where(eq(agentRuns.id, run.runId));
        await transaction
          .update(agentTasks)
          .set({ status: 'running', attempt: 1 })
          .where(eq(agentTasks.id, researchTask.id));
      });
      const results = new SpecialistResultStore({
        database: connection.db,
        publisher,
        createId: randomUUID,
        now: () => new Date(),
      });
      await expect(
        results.persistTaskResult(
          run.runId,
          {
            ...researchTask,
            status: 'succeeded',
            summary: 'Verified research survives recovery.',
            artifacts: [
              {
                type: 'ResearchBrief',
                title: 'Preserved research',
                summary: 'Committed before the writer interruption',
                content: { summary: 'immutable research fact' },
                evidenceIds: [],
              },
            ],
            warnings: [],
          },
          1,
        ),
      ).resolves.toBe(true);
      await connection.db
        .update(agentTasks)
        .set({ status: 'running', attempt: 1 })
        .where(eq(agentTasks.id, writerTask.id));
      const preservedBefore = await connection.db
        .select({
          artifactId: artifacts.id,
          versionId: artifactVersions.id,
          version: artifactVersions.version,
          content: artifactVersions.content,
        })
        .from(artifacts)
        .innerJoin(artifactVersions, eq(artifactVersions.artifactId, artifacts.id))
        .where(eq(artifacts.taskId, researchTask.id));

      await expect(service.prepareRecovery(run.runId)).resolves.toBe(true);
      await expect(
        within(service.execute(run.runId), 4_000, 'recovery execution'),
      ).resolves.toEqual({
        runId: run.runId,
        status: 'completed_with_degradation',
      });

      await expect(
        within(provider.requestStarted, 1_000, 'provider request start'),
      ).resolves.toBeUndefined();
      expect(provider.requests()).toBe(1);
      await expect(
        within(provider.requestClosed, 1_000, 'provider request close'),
      ).resolves.toBeUndefined();
      const persistedTasks = await connection.db
        .select({ id: agentTasks.id, status: agentTasks.status, attempt: agentTasks.attempt })
        .from(agentTasks)
        .where(eq(agentTasks.runId, run.runId));
      expect(persistedTasks).toContainEqual({
        id: researchTask.id,
        status: 'succeeded',
        attempt: 1,
      });
      expect(persistedTasks).toContainEqual({ id: writerTask.id, status: 'failed', attempt: 2 });
      const writerResults = await connection.db
        .select({
          attempt: taskResults.attempt,
          status: taskResults.status,
          failure: taskResults.failure,
        })
        .from(taskResults)
        .where(eq(taskResults.taskId, writerTask.id));
      expect(writerResults).toEqual([
        {
          attempt: 2,
          status: 'failed',
          failure: { code: 'task_timeout', message: 'task_timeout' },
        },
      ]);
      const preservedAfter = await connection.db
        .select({
          artifactId: artifacts.id,
          versionId: artifactVersions.id,
          version: artifactVersions.version,
          content: artifactVersions.content,
        })
        .from(artifacts)
        .innerJoin(artifactVersions, eq(artifactVersions.artifactId, artifacts.id))
        .where(eq(artifacts.taskId, researchTask.id));
      expect(preservedAfter).toEqual(preservedBefore);
      expect(preservedAfter).toHaveLength(1);
      const projection = await service.getProjection(run.runId);
      expect(projection?.parts.find(({ status }) => status === 'task.failed')).toMatchObject({
        outcome: 'timed_out',
        payload: { taskId: writerTask.id, attempt: 2, failure: 'task_timeout' },
      });
      expect(projection?.artifacts).toContainEqual(
        expect.objectContaining({ id: preservedBefore[0]?.artifactId, version: 1 }),
      );
    } finally {
      await provider.close();
    }
  }, 10_000);
});

function currentTurn(request: string): RuntimeCurrentTurn {
  return {
    type: 'agentpress_current_turn',
    version: RUNTIME_CURRENT_TURN_VERSION,
    source: 'recovery',
    request,
    actionEnvelope: { version: 1, source: 'free_text', grantedCapabilities: [] },
    timestamp: Date.now(),
  };
}

function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${String(timeoutMs)} ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(`${label} failed`));
      },
    );
  });
}

function task(
  clientKey: string,
  owner: PlannedTaskSpec['owner'],
  criticality: PlannedTaskSpec['criticality'],
  dependencyIds: readonly string[] = [],
): PlannedTaskSpec {
  return {
    id: randomUUID(),
    clientKey,
    owner,
    objective: `${owner} recovery objective`,
    criticality,
    acceptanceCriteria: [`${owner} recovery result is complete`],
    dependencyIds,
    capabilities: [],
    detached: false,
  };
}

async function startHangingOpenAiProvider(): Promise<{
  readonly baseUrl: string;
  readonly requests: () => number;
  readonly requestStarted: Promise<void>;
  readonly requestClosed: Promise<void>;
  readonly close: () => Promise<void>;
}> {
  let requests = 0;
  let resolveStarted: () => void = () => undefined;
  let resolveClosed: () => void = () => undefined;
  const requestStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const requestClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    requests += 1;
    resolveStarted();
    request.on('aborted', resolveClosed);
    response.on('close', resolveClosed);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider fixture did not bind TCP');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests: () => requests,
    requestStarted,
    requestClosed,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

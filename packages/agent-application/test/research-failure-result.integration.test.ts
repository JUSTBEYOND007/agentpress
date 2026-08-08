import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PiRuntimeAdapter } from '@agentpress/agent-runtime';
import {
  agentTasks,
  appUsers,
  artifactEvidence,
  artifacts,
  artifactVersions,
  connectDatabase,
  conversationBranches,
  conversations,
  evidenceRecords,
  runEvents,
  taskResults,
  toolCalls,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DirectRunService, type RunEventPublisher } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Research failure result', () => {
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
      displayName: 'Research Failure User',
    });
    await connection.db.insert(workspaces).values({ id: ids.workspace, name: 'Research Failure' });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Research Failure',
    });
  });

  afterAll(async () => connection.close());

  it('persists retained Evidence in a claim-free confidence-zero degraded ResearchBrief', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const evidenceId = randomUUID();
    const sourceToolCallId = randomUUID();
    let researcherTaskId: string | undefined;
    const service = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: (purpose) => {
          if (purpose === 'synthesis') {
            return PiRuntimeAdapter.forTests({
              responses: [runCompleteResponse('Research is incomplete and requires verification.')],
            });
          }
          if (purpose === 'main') {
            return PiRuntimeAdapter.forTests({
              responses: [
                fauxAssistantMessage(
                  [
                    fauxToolCall('plan_submit', {
                      goal: 'Research a topic',
                      tasks: [
                        {
                          clientKey: 'research',
                          owner: 'researcher',
                          objective: 'Research the topic',
                          criticality: 'required',
                          acceptanceCriteria: ['Return a verified brief'],
                          dependencyKeys: [],
                          capabilities: ['web.research'],
                        },
                      ],
                    }),
                  ],
                  { stopReason: 'toolUse' },
                ),
                runCompleteResponse('Research is incomplete and requires verification.'),
              ],
            });
          }
          return PiRuntimeAdapter.forTests({
            responses: ['The researcher stopped before synthesis.'],
          });
        },
      },
      runtimeToolFactory: {
        listCapabilities: () => Promise.resolve(['web.research']),
        createForRun: async (runId, _capabilities, taskId) => {
          if (taskId && researcherTaskId === undefined) {
            researcherTaskId = taskId;
            await connection.db.insert(toolCalls).values({
              id: sourceToolCallId,
              runId,
              taskId,
              taskAttempt: 1,
              toolId: 'web.search',
              toolVersion: '1.0.0',
              evidenceProviderRevision: 'anysearch-api-v1+pi-web-access-v0.15.0',
              arguments: { query: 'topic' },
              argumentsHash: createHash('sha256').update('{"query":"topic"}').digest('hex'),
              risk: 'read_only',
              sideEffect: 'Reads bounded sources',
              status: 'succeeded',
            });
            await connection.db.insert(evidenceRecords).values({
              id: evidenceId,
              runId,
              taskId,
              sourceToolCallId,
              sourceType: 'tool',
              sourceUri: 'https://example.test/source',
              title: 'Retained source',
              excerpt: 'A retained source excerpt.',
              sourceRevision: 'source-v1',
              contentHash: createHash('sha256').update('A retained source excerpt.').digest('hex'),
              metadata: { toolId: 'web.search' },
            });
          }
          return [];
        },
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await service.create({
      conversationId: ids.conversation,
      branchId,
      userId: ids.user,
      prompt: 'Research this topic.',
      idempotencyKey: randomUUID(),
    });

    await expect(service.execute(run.runId)).resolves.toEqual({
      runId: run.runId,
      status: 'failed',
    });
    const task = await connection.db
      .select({ id: agentTasks.id, status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.runId, run.runId));
    expect(task).toHaveLength(1);
    expect(task[0]?.status).toBe('failed');
    const persisted = await connection.db
      .select({ artifacts: taskResults.artifacts, failure: taskResults.failure })
      .from(taskResults)
      .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
      .where(eq(agentTasks.runId, run.runId));
    const artifact = (persisted[0]?.artifacts as readonly Record<string, unknown>[])[0];
    expect(persisted[0]?.failure).toMatchObject({ code: 'protocol_error' });
    expect(artifact).toMatchObject({ type: 'ResearchBrief', evidenceIds: [evidenceId] });
    expect(artifact?.content).toMatchObject({ claims: [], confidence: 0 });
    const versionRows = await connection.db
      .select({ id: artifactVersions.id, content: artifactVersions.content })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(and(eq(artifacts.runId, run.runId), eq(artifacts.type, 'ResearchBrief')));
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]?.content).toMatchObject({ claims: [], confidence: 0 });
    await expect(
      connection.db
        .select({ evidenceId: artifactEvidence.evidenceId })
        .from(artifactEvidence)
        .where(eq(artifactEvidence.artifactVersionId, versionRows[0]?.id ?? '')),
    ).resolves.toEqual([{ evidenceId }]);
    const events = await connection.db
      .select({ eventType: runEvents.eventType })
      .from(runEvents)
      .where(eq(runEvents.runId, run.runId));
    expect(events.some(({ eventType }) => eventType === 'task.succeeded')).toBe(false);
    expect(events.some(({ eventType }) => eventType === 'task.failed')).toBe(true);
  });
});

function runCompleteResponse(answer: string) {
  return fauxAssistantMessage(
    [fauxToolCall('run_complete', { answer, artifactIds: [], evidenceIds: [] })],
    { stopReason: 'toolUse' },
  );
}

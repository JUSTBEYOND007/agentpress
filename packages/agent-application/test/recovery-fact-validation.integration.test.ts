import { createHash, randomUUID } from 'node:crypto';
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
  articleRevisions,
  articles,
  connectDatabase,
  conversationBranches,
  conversations,
  executionPlans,
  planRevisions,
  runEvents,
  taskResultInvalidations,
  taskResults,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { and, eq } from 'drizzle-orm';
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

describeWithDatabase('Recovery fact validation', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
    article: randomUUID(),
    revision1: randomUUID(),
    revision2: randomUUID(),
  };
  const publisher: RunEventPublisher = { publish: () => Promise.resolve() };

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Recovery Validation User',
    });
    await connection.db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Recovery Validation Workspace',
    });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(articles).values({
      id: ids.article,
      workspaceId: ids.workspace,
      title: 'Recovery article',
    });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      articleId: ids.article,
      title: 'Recovery Validation',
    });
    const first = articleDocument('first-revision', 'First revision');
    const second = articleDocument('second-revision', 'Second revision');
    await connection.db.insert(articleRevisions).values([
      {
        id: ids.revision1,
        articleId: ids.article,
        revisionNumber: 1,
        schemaVersion: 1,
        document: first,
        documentHash: contentHash(first),
        source: 'manual',
        createdByUserId: ids.user,
      },
      {
        id: ids.revision2,
        articleId: ids.article,
        revisionNumber: 2,
        schemaVersion: 1,
        document: second,
        documentHash: contentHash(second),
        source: 'manual',
        createdByUserId: ids.user,
      },
    ]);
    await connection.db
      .update(articles)
      .set({ currentRevisionId: ids.revision2 })
      .where(eq(articles.id, ids.article));
  });

  afterAll(async () => {
    await connection.close();
  });

  it('degrades a recovered ArticleDraft with stale revision and missing Evidence', async () => {
    const missingEvidenceId = randomUUID();
    const fixture = await createRecoveryFixture({
      baseRevisionId: ids.revision1,
      claims: [{ text: 'Unsupported recovery fact', evidenceIds: [missingEvidenceId] }],
    });

    await expect(fixture.service.prepareRecovery(fixture.runId)).resolves.toBe(true);
    await expect(fixture.service.execute(fixture.runId)).resolves.toEqual({
      runId: fixture.runId,
      status: 'completed_with_degradation',
    });

    const eventRows = await connection.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(
        and(eq(runEvents.runId, fixture.runId), eq(runEvents.eventType, 'run.recovery.degraded')),
      );
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]?.payload).toMatchObject({
      preservedFacts: [
        {
          kind: 'article_revision',
          id: ids.revision2,
          revision: ids.revision2,
        },
      ],
      missingFacts: [
        {
          code: 'evidence_missing',
          reference: fixture.artifactVersionId,
        },
      ],
      nextActions: [
        {
          kind: 'regenerate_artifact',
          labelKey: 'recovery.action.regenerate_artifact',
          targetId: fixture.artifactVersionId,
        },
      ],
    });
    expect(eventRows[0]?.payload.unverified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'stale_revision' }),
        expect.objectContaining({ code: 'missing_evidence' }),
      ]),
    );
    const projection = await fixture.service.getProjection(fixture.runId);
    const degradedPart = projection?.parts.find(({ status }) => status === 'run.recovery.degraded');
    expect(degradedPart).toMatchObject({
      type: 'recovery',
      outcome: 'degraded',
    });
    expect(Array.isArray(degradedPart?.payload.nextActions)).toBe(true);
    await expect(currentArtifact(fixture.artifactId)).resolves.toEqual({
      id: fixture.artifactVersionId,
      version: 1,
    });
  });

  it('keeps a valid recovered ArticleDraft successful without fabricating degradation', async () => {
    const fixture = await createRecoveryFixture({ baseRevisionId: ids.revision2, claims: [] });

    await expect(fixture.service.prepareRecovery(fixture.runId)).resolves.toBe(true);
    await expect(fixture.service.execute(fixture.runId)).resolves.toEqual({
      runId: fixture.runId,
      status: 'completed',
    });

    const projection = await fixture.service.getProjection(fixture.runId);
    const validatedPart = projection?.parts.find(
      ({ status }) => status === 'run.recovery.validated',
    );
    expect(validatedPart).toMatchObject({
      type: 'recovery',
      outcome: 'succeeded',
    });
    expect(validatedPart?.payload.preservedFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'artifact_version',
          id: fixture.artifactVersionId,
          revision: '1',
        }),
      ]),
    );
    expect(projection?.parts.some(({ status }) => status === 'run.recovery.degraded')).toBe(false);
  });

  it('invalidates only the damaged writer result and reruns that branch', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const calls: string[] = [];
    const researcher = task('researcher', 'researcher', 'required');
    const writer = task('writer', 'writer', 'required', [researcher.id]);
    const service = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: (purpose) => {
          calls.push(purpose ?? 'unknown');
          if (purpose !== 'writer' && purpose !== 'researcher') {
            return PiRuntimeAdapter.forTests({
              responses: [runCompleteResponse('Recovered writer branch.')],
            });
          }
          if (purpose === 'researcher') {
            return PiRuntimeAdapter.forTests({
              responses: [taskCompleteResponse('Research remains valid')],
            });
          }
          return PiRuntimeAdapter.forTests({
            responses: [
              taskCompleteResponse('Writer attempt two completed', {
                baseRevisionId: ids.revision2,
                document: articleDocument('writer-attempt-2', 'Valid recovered draft'),
                claims: [],
              }),
            ],
          });
        },
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await service.create({
      conversationId: ids.conversation,
      branchId,
      userId: ids.user,
      prompt: 'Recover the damaged writer branch.',
      idempotencyKey: randomUUID(),
    });
    const planId = randomUUID();
    const revisionId = randomUUID();
    const turn = currentTurn('Recover the damaged writer branch.');
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
        summary: 'Recover only the damaged writer branch',
      });
      await store.persistRevisionTasks(
        transaction,
        run.runId,
        revisionId,
        [researcher, writer],
        turn,
      );
      await transaction
        .update(agentRuns)
        .set({ mode: 'planned', status: 'running', activePlanRevisionId: revisionId })
        .where(eq(agentRuns.id, run.runId));
      await transaction
        .update(agentTasks)
        .set({ status: 'running', attempt: 1 })
        .where(eq(agentTasks.runId, run.runId));
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
          ...researcher,
          status: 'succeeded',
          summary: 'Research remains valid',
          artifacts: [],
          warnings: [],
        },
        1,
      ),
    ).resolves.toBe(true);
    await expect(
      results.persistTaskResult(
        run.runId,
        {
          ...writer,
          status: 'succeeded',
          summary: 'Stale writer result',
          artifacts: [
            {
              type: 'ArticleDraft',
              title: 'Stale draft',
              summary: 'Must be invalidated',
              content: {
                baseRevisionId: ids.revision1,
                document: articleDocument('writer-attempt-1', 'Stale draft'),
                claims: [],
              },
              evidenceIds: [],
            },
          ],
          warnings: [],
        },
        1,
      ),
    ).resolves.toBe(true);

    await expect(service.prepareRecovery(run.runId)).resolves.toBe(true);
    await expect(service.execute(run.runId)).resolves.toEqual({
      runId: run.runId,
      status: 'completed',
    });

    expect(calls.filter((call) => call === 'researcher')).toHaveLength(0);
    expect(calls.filter((call) => call === 'writer')).toHaveLength(1);
    expect(calls.filter((call) => call === 'synthesis')).toHaveLength(1);
    await expect(
      connection.db
        .select({ owner: agentTasks.owner, attempt: agentTasks.attempt, status: agentTasks.status })
        .from(agentTasks)
        .where(eq(agentTasks.runId, run.runId)),
    ).resolves.toEqual(
      expect.arrayContaining([
        { owner: 'researcher', attempt: 1, status: 'succeeded' },
        { owner: 'writer', attempt: 2, status: 'succeeded' },
      ]),
    );
    const invalidations = await connection.db
      .select({ taskId: taskResultInvalidations.taskId, reason: taskResultInvalidations.reason })
      .from(taskResultInvalidations)
      .where(eq(taskResultInvalidations.runId, run.runId));
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]).toMatchObject({
      taskId: writer.id,
      reason: 'recovery_validation_failed',
    });
    await expect(
      connection.db
        .select({ attempt: taskResults.attempt })
        .from(taskResults)
        .where(eq(taskResults.taskId, writer.id)),
    ).resolves.toEqual(expect.arrayContaining([{ attempt: 1 }, { attempt: 2 }]));
    await expect(
      connection.db
        .select({ version: artifactVersions.version })
        .from(artifactVersions)
        .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
        .where(eq(artifacts.taskId, writer.id)),
    ).resolves.toHaveLength(2);
    const projection = await service.getProjection(run.runId);
    const interruptedPart = projection?.parts.find(({ status }) => status === 'task.interrupted');
    expect(interruptedPart?.payload).toMatchObject({
      taskId: writer.id,
      reason: 'recovery_validation_failed',
    });
    expect(projection?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'run.recovery.validated', outcome: 'succeeded' }),
      ]),
    );
  });

  async function createRecoveryFixture(input: {
    readonly baseRevisionId: string;
    readonly claims: readonly { readonly text: string; readonly evidenceIds: readonly string[] }[];
  }) {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const service = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: () => PiRuntimeAdapter.forTests({ responses: ['Recovered direct answer.'] }),
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await service.create({
      conversationId: ids.conversation,
      branchId,
      userId: ids.user,
      prompt: 'Resume the interrupted direct answer.',
      idempotencyKey: randomUUID(),
    });
    await connection.db
      .update(agentRuns)
      .set({ status: 'running' })
      .where(eq(agentRuns.id, run.runId));
    const artifactId = randomUUID();
    const artifactVersionId = randomUUID();
    const content = {
      baseRevisionId: input.baseRevisionId,
      document: articleDocument(`draft-${artifactId}`, 'Recovered article fact'),
      claims: input.claims,
    };
    await connection.db.insert(artifacts).values({
      id: artifactId,
      runId: run.runId,
      type: 'ArticleDraft',
      title: 'Recovered draft',
    });
    await connection.db.insert(artifactVersions).values({
      id: artifactVersionId,
      artifactId,
      version: 1,
      summary: 'Recovered ArticleDraft',
      content,
      contentHash: contentHash(content),
    });
    return { service, runId: run.runId, artifactId, artifactVersionId };
  }

  async function currentArtifact(artifactId: string) {
    const rows = await connection.db
      .select({ id: artifactVersions.id, version: artifactVersions.version })
      .from(artifactVersions)
      .innerJoin(
        artifacts,
        and(
          eq(artifacts.id, artifactVersions.artifactId),
          eq(artifacts.currentVersion, artifactVersions.version),
        ),
      )
      .where(eq(artifacts.id, artifactId));
    return rows[0];
  }
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

function taskCompleteResponse(
  summary: string,
  articleDraft?: {
    readonly baseRevisionId: string;
    readonly document: unknown;
    readonly claims: readonly unknown[];
  },
) {
  return fauxAssistantMessage(
    [
      fauxToolCall('task_complete', {
        status: 'succeeded',
        summary,
        artifacts: articleDraft
          ? [
              {
                type: 'ArticleDraft',
                title: 'Recovered draft',
                summary,
                content: articleDraft,
                evidenceIds: [],
              },
            ]
          : [],
        warnings: [],
      }),
    ],
    { stopReason: 'toolUse' },
  );
}

function runCompleteResponse(answer: string) {
  return fauxAssistantMessage(
    [fauxToolCall('run_complete', { answer, artifactIds: [], evidenceIds: [] })],
    { stopReason: 'toolUse' },
  );
}

function articleDocument(blockId: string, text: string) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { blockId },
        content: [{ type: 'text', text }],
      },
    ],
  };
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

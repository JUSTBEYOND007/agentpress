import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PiRuntimeAdapter } from '@agentpress/agent-runtime';
import {
  agentRuns,
  appUsers,
  artifacts,
  artifactVersions,
  articleRevisions,
  articles,
  connectDatabase,
  conversationBranches,
  conversations,
  runEvents,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DirectRunService, type RunEventPublisher } from '../src/index.js';

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

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  agentRuns,
  agentTasks,
  appUsers,
  artifacts,
  artifactVersions,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  executionPlans,
  planRevisions,
  reviewRounds,
  rootRequests,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ArticleReviewStore, reviewArticleDeterministically } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Article review PostgreSQL store', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
    branch: randomUUID(),
    message: randomUUID(),
    request: randomUUID(),
    run: randomUUID(),
    plan: randomUUID(),
    planRevision: randomUUID(),
    writerTask: randomUUID(),
    reviewTask: randomUUID(),
    artifact: randomUUID(),
    version1: randomUUID(),
    version2: randomUUID(),
  };

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Review Store User',
    });
    await connection.db.insert(workspaces).values({ id: ids.workspace, name: 'Review Store' });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Review Store',
    });
    await connection.db.insert(conversationBranches).values({
      id: ids.branch,
      conversationId: ids.conversation,
    });
    await connection.db.insert(conversationMessages).values({
      id: ids.message,
      branchId: ids.branch,
      role: 'user',
      sequence: 1,
      content: ['review'],
      stable: true,
    });
    await connection.db.insert(rootRequests).values({
      id: ids.request,
      branchId: ids.branch,
      messageId: ids.message,
      requestedByUserId: ids.user,
      idempotencyKey: randomUUID(),
    });
    await connection.db.insert(agentRuns).values({
      id: ids.run,
      workspaceId: ids.workspace,
      branchId: ids.branch,
      rootRequestId: ids.request,
      mode: 'planned',
      status: 'running',
    });
    await connection.db.insert(executionPlans).values({ id: ids.plan, runId: ids.run });
    await connection.db.insert(planRevisions).values({
      id: ids.planRevision,
      planId: ids.plan,
      revisionNumber: 1,
      reason: 'main_agent',
      summary: 'Review an immutable draft',
    });
    await connection.db
      .insert(agentTasks)
      .values([task(ids.writerTask, ids, 'writer'), task(ids.reviewTask, ids, 'fact_checker')]);
    await connection.db.insert(artifacts).values({
      id: ids.artifact,
      runId: ids.run,
      taskId: ids.writerTask,
      type: 'ArticleDraft',
      title: 'Draft',
      currentVersion: 2,
    });
    await connection.db
      .insert(artifactVersions)
      .values([
        artifactVersion(ids.version1, ids.artifact, 1),
        artifactVersion(ids.version2, ids.artifact, 2),
      ]);
  });

  afterAll(async () => {
    await connection.db.delete(workspaces).where(eq(workspaces.id, ids.workspace));
    await connection.close();
  });

  it('persists each immutable candidate review and marks only the selected version', async () => {
    const store = new ArticleReviewStore({
      database: connection.db,
      taskId: ids.reviewTask,
      reviewer: 'fact_checker',
      createId: randomUUID,
    });
    const first = assessed(ids, 1, ids.version1);
    const second = assessed(ids, 2, ids.version2);
    await store.recordRound({
      round: 1,
      candidate: { ...first, modelScore: 70, modelIssues: [] },
      modelPassed: false,
      modelParseFailed: false,
      usage: usage(12),
    });
    await store.recordRound({
      round: 2,
      candidate: { ...second, modelScore: 92, modelIssues: [] },
      modelPassed: true,
      modelParseFailed: false,
      usage: usage(18),
    });
    await store.recordSelection({
      artifactVersionId: ids.version2,
      reason: 'passed_all_gates',
    });

    const rows = await connection.db
      .select()
      .from(reviewRounds)
      .where(eq(reviewRounds.taskId, ids.reviewTask))
      .orderBy(reviewRounds.round);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      artifactVersionId: ids.version1,
      score: 70,
      accepted: false,
      selectionReason: null,
    });
    expect(rows[1]).toMatchObject({
      artifactVersionId: ids.version2,
      score: 92,
      accepted: true,
      selectionReason: 'passed_all_gates',
      usage: { totalTokens: 18, costUsd: 0.02 },
    });
  });
});

function task(
  id: string,
  ids: { readonly run: string; readonly planRevision: string },
  owner: 'writer' | 'fact_checker',
) {
  return {
    id,
    runId: ids.run,
    planRevisionId: ids.planRevision,
    objective: `${owner} draft`,
    criticality: 'required' as const,
    owner,
    acceptanceCriteria: ['Produces a bounded result'],
    outputSchema: {},
    toolPolicy: { capabilities: [] },
    budget: { maxAttempts: 3 },
    status: 'pending' as const,
  };
}

function artifactVersion(id: string, artifactId: string, version: number) {
  return {
    id,
    artifactId,
    version,
    summary: `version ${String(version)}`,
    content: { document: document(version), baseRevisionId: 'revision-1' },
    contentHash: `hash-${String(version)}`,
  };
}

function assessed(ids: { readonly artifact: string }, version: number, versionId: string) {
  const candidate = {
    artifactId: ids.artifact,
    artifactVersionId: versionId,
    version,
    baseRevisionId: 'revision-1',
    document: document(version),
    claims: [],
    evidenceIds: [],
    summary: `version ${String(version)}`,
  };
  return {
    candidate,
    deterministic: reviewArticleDeterministically(candidate, {
      currentRevisionId: 'revision-1',
      availableEvidenceIds: new Set(),
      minCharacters: 5,
      maxCharacters: 1_000,
      maxBlocks: 20,
    }),
  };
}

function document(version: number) {
  return {
    type: 'doc' as const,
    content: [
      {
        type: 'paragraph',
        attrs: { blockId: `block-${String(version)}` },
        content: [{ type: 'text', text: `Review candidate ${String(version)}` }],
      },
    ],
  };
}

function usage(totalTokens: number) {
  return {
    inputTokens: totalTokens - 2,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
    costUsd: 0.02,
  };
}

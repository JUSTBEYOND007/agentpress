import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  agentRuns,
  appUsers,
  articleRevisions,
  articles,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  editProposals,
  rootRequests,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConversationOverviewService } from '../src/conversation-overview-service.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Conversation overview projection', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    article: randomUUID(),
    revision: randomUUID(),
    conversation: randomUUID(),
    branch: randomUUID(),
    message: randomUUID(),
    request: randomUUID(),
    run: randomUUID(),
    proposal: randomUUID(),
    workspaceConversation: randomUUID(),
    workspaceBranch: randomUUID(),
  };
  const completedAt = new Date('2026-08-03T10:00:00.000Z');
  const statusCases = [
    { status: 'waiting_for_user' as const, completedAt: null },
    { status: 'waiting_for_approval' as const, completedAt: null },
    { status: 'failed' as const, completedAt },
  ].map((entry) => ({
    ...entry,
    conversationId: randomUUID(),
    branchId: randomUUID(),
    messageId: randomUUID(),
    requestId: randomUUID(),
    runId: randomUUID(),
  }));
  const service = new ConversationOverviewService(
    connection.db,
    () => new Date('2026-08-03T11:00:00.000Z'),
  );

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Conversation Reader',
    });
    await connection.db
      .insert(workspaces)
      .values({ id: ids.workspace, name: 'Overview Workspace' });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(articles).values({
      id: ids.article,
      workspaceId: ids.workspace,
      title: 'Overview Article',
    });
    await connection.db.insert(articleRevisions).values({
      id: ids.revision,
      articleId: ids.article,
      revisionNumber: 1,
      schemaVersion: 1,
      document: { type: 'doc', content: [] },
      documentHash: randomUUID(),
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId: ids.revision })
      .where(eq(articles.id, ids.article));
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      articleId: ids.article,
      title: 'Background Run',
      isDefault: true,
    });
    await connection.db.insert(conversationBranches).values({
      id: ids.branch,
      conversationId: ids.conversation,
    });
    await connection.db.insert(conversations).values({
      id: ids.workspaceConversation,
      workspaceId: ids.workspace,
      articleId: null,
      title: 'Workspace Research',
      isDefault: true,
    });
    await connection.db.insert(conversationBranches).values({
      id: ids.workspaceBranch,
      conversationId: ids.workspaceConversation,
    });
    await connection.db.insert(conversationMessages).values({
      id: ids.message,
      branchId: ids.branch,
      role: 'user',
      sequence: 1,
      content: ['write'],
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
      mode: 'direct',
      status: 'completed',
      completedAt,
    });
    await connection.db.insert(conversations).values(
      statusCases.map(({ conversationId, status }) => ({
        id: conversationId,
        workspaceId: ids.workspace,
        articleId: ids.article,
        title: status,
      })),
    );
    await connection.db.insert(conversationBranches).values(
      statusCases.map(({ branchId, conversationId }) => ({
        id: branchId,
        conversationId,
      })),
    );
    await connection.db.insert(conversationMessages).values(
      statusCases.map(({ branchId, messageId }) => ({
        id: messageId,
        branchId,
        role: 'user' as const,
        sequence: 1,
        content: ['status'],
        stable: true,
      })),
    );
    await connection.db.insert(rootRequests).values(
      statusCases.map(({ branchId, messageId, requestId }) => ({
        id: requestId,
        branchId,
        messageId,
        requestedByUserId: ids.user,
        idempotencyKey: randomUUID(),
      })),
    );
    await connection.db.insert(agentRuns).values(
      statusCases.map(({ branchId, completedAt: caseCompletedAt, requestId, runId, status }) => ({
        id: runId,
        workspaceId: ids.workspace,
        branchId,
        rootRequestId: requestId,
        mode: 'direct' as const,
        status,
        completedAt: caseCompletedAt,
      })),
    );
    await connection.db.insert(editProposals).values({
      id: ids.proposal,
      articleId: ids.article,
      runId: ids.run,
      baseRevisionId: ids.revision,
      operations: [],
      reviewMode: 'document',
      expiresAt: new Date('2026-08-04T00:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await connection.db.delete(workspaces).where(eq(workspaces.id, ids.workspace));
    await connection.db.delete(appUsers).where(eq(appUsers.id, ids.user));
    await connection.close();
  });

  it('projects durable Run, review, and unread facts for every branch', async () => {
    const overview = await service.listForArticle(ids.article, ids.user);
    expect(overview.find(({ branchId }) => branchId === ids.branch)).toMatchObject({
      id: ids.conversation,
      branchId: ids.branch,
      status: 'completed',
      latestRunId: ids.run,
      pendingReview: true,
      unread: true,
    });
    for (const { branchId, completedAt: caseCompletedAt, runId, status } of statusCases) {
      expect(overview.find((item) => item.branchId === branchId)).toMatchObject({
        branchId,
        status,
        latestRunId: runId,
        pendingReview: false,
        unread: Boolean(caseCompletedAt),
      });
    }
  });

  it('marks only the selected user and branch as read', async () => {
    await service.markRead(ids.user, ids.branch);
    const overview = await service.listForArticle(ids.article, ids.user);
    expect(overview.find(({ branchId }) => branchId === ids.branch)?.unread).toBe(false);
    expect(overview.find(({ branchId }) => branchId === statusCases[2]?.branchId)?.unread).toBe(
      true,
    );
  });

  it('keeps workspace conversations separate from article conversations', async () => {
    const workspaceOverview = await service.listForWorkspace(ids.workspace, ids.user);
    expect(workspaceOverview).toEqual([
      expect.objectContaining({
        id: ids.workspaceConversation,
        branchId: ids.workspaceBranch,
        status: 'ready',
        pendingReview: false,
      }),
    ]);

    const articleOverview = await service.listForArticle(ids.article, ids.user);
    expect(articleOverview.some(({ id }) => id === ids.workspaceConversation)).toBe(false);
  });
});

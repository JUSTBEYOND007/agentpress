import { createHash, randomUUID } from 'node:crypto';

import {
  articleRevisions,
  articles,
  conversationBranches,
  conversations,
  type DatabaseConnection,
  workspaceMembers,
  workspaces,
  enqueueOutboxMessage,
} from '@agentpress/database';
import { ARTICLE_INDEX_COMMAND_TOPIC } from '@agentpress/knowledge-retrieval';
import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../agent/agent.providers.js';
import { CurrentUser } from '../auth/current-user.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { AuthorizationService } from '../auth/authorization.service.js';

type CreateArticleBody = {
  readonly title?: unknown;
};

const emptyDocument = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1, blockId: 'title' },
      content: [{ type: 'text', text: '无标题' }],
    },
    { type: 'paragraph', attrs: { blockId: 'lead' } },
  ],
} as const;

@Controller()
export class WorkspaceController {
  public constructor(
    @Inject(DATABASE_CONNECTION) private readonly connection: DatabaseConnection,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  @Get('me/workspace')
  public async myWorkspace(@CurrentUser() user: AuthenticatedUser) {
    return this.connection.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${user.id}))`);
      const existing = await transaction
        .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(eq(workspaceMembers.userId, user.id))
        .orderBy(asc(workspaceMembers.createdAt))
        .limit(1);
      if (existing[0]) return existing[0];
      const workspaceId = randomUUID();
      const name = `${user.displayName}的工作区`.slice(0, 180);
      await transaction.insert(workspaces).values({
        id: workspaceId,
        name,
      });
      await transaction.insert(workspaceMembers).values({
        workspaceId,
        userId: user.id,
        role: 'owner',
      });
      return { id: workspaceId, name, role: 'owner' };
    });
  }

  @Get('workspaces/:workspaceId/articles')
  public async listArticles(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    const rows = await this.connection.db
      .select({
        id: articles.id,
        title: articles.title,
        revisionId: articleRevisions.id,
        document: articleRevisions.document,
        updatedAt: articles.updatedAt,
      })
      .from(articles)
      .innerJoin(articleRevisions, eq(articleRevisions.id, articles.currentRevisionId))
      .where(eq(articles.workspaceId, workspaceId))
      .orderBy(desc(articles.updatedAt));

    const conversationsByArticle = await this.connection.db
      .select({
        articleId: conversations.articleId,
        conversationId: conversations.id,
        branchId: conversationBranches.id,
      })
      .from(conversations)
      .innerJoin(conversationBranches, eq(conversationBranches.conversationId, conversations.id))
      .where(eq(conversations.workspaceId, workspaceId));

    return rows.map((row) => {
      const conversation = conversationsByArticle.find((item) => item.articleId === row.id);
      return {
        ...row,
        updatedAt: row.updatedAt.toISOString(),
        conversationId: conversation?.conversationId,
        branchId: conversation?.branchId,
      };
    });
  }

  @Post('workspaces/:workspaceId/articles')
  public async createArticle(
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateArticleBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (typeof body.title !== 'string') {
      throw new BadRequestException('title is required');
    }
    const title = body.title.trim();
    if (title.length === 0 || title.length > 300) {
      throw new BadRequestException('title must contain between 1 and 300 characters');
    }
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    const userId = user.id;

    const articleId = randomUUID();
    const revisionId = randomUUID();
    const conversationId = randomUUID();
    const branchId = randomUUID();
    const document = {
      ...emptyDocument,
      content: [
        {
          type: 'heading',
          attrs: { level: 1, blockId: 'title' },
          content: [{ type: 'text', text: title }],
        },
        emptyDocument.content[1],
      ],
    };
    const documentHash = createHash('sha256').update(JSON.stringify(document)).digest('hex');

    await this.connection.db.transaction(async (transaction) => {
      await transaction.insert(articles).values({ id: articleId, workspaceId, title });
      await transaction.insert(articleRevisions).values({
        id: revisionId,
        articleId,
        revisionNumber: 1,
        schemaVersion: 1,
        document,
        documentHash,
        source: 'manual',
        createdByUserId: userId,
      });
      await transaction
        .update(articles)
        .set({ currentRevisionId: revisionId })
        .where(eq(articles.id, articleId));
      await transaction.insert(conversations).values({
        id: conversationId,
        workspaceId,
        articleId,
        title,
      });
      await transaction.insert(conversationBranches).values({ id: branchId, conversationId });
      const indexMessageId = randomUUID();
      await enqueueOutboxMessage(transaction, {
        id: indexMessageId,
        aggregateType: 'ArticleRevision',
        aggregateId: revisionId,
        topic: ARTICLE_INDEX_COMMAND_TOPIC,
        messageKey: articleId,
        payload: { command: 'article.index', messageId: indexMessageId, revisionId },
        occurredAt: new Date(),
      });
    });

    return {
      id: articleId,
      title,
      revisionId,
      document,
      conversationId,
      branchId,
      updatedAt: new Date().toISOString(),
    };
  }
}

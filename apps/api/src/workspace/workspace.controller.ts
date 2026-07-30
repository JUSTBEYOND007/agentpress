import { createHash, randomUUID } from 'node:crypto';

import {
  articleRevisions,
  articles,
  conversationBranches,
  conversations,
  type DatabaseConnection,
} from '@agentpress/database';
import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../agent/agent.providers.js';

type CreateArticleBody = {
  readonly title?: unknown;
  readonly userId?: unknown;
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
  ) {}

  @Get('workspaces/:workspaceId/articles')
  public async listArticles(@Param('workspaceId') workspaceId: string) {
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
  ) {
    if (typeof body.title !== 'string' || typeof body.userId !== 'string') {
      throw new BadRequestException('title and userId are required');
    }
    const title = body.title.trim();
    if (title.length === 0 || title.length > 300) {
      throw new BadRequestException('title must contain between 1 and 300 characters');
    }
    const userId = body.userId;

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

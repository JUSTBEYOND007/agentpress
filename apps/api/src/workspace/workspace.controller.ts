import { createHash, randomUUID } from 'node:crypto';

import {
  articleRevisions,
  articles,
  contentFolders,
  conversationBranches,
  conversations,
  type DatabaseConnection,
  type DatabaseTransaction,
  workspaceMembers,
  workspaces,
  enqueueOutboxMessage,
} from '@agentpress/database';
import { ARTICLE_INDEX_COMMAND_TOPIC } from '@agentpress/knowledge-retrieval';
import { ConversationOverviewService } from '@agentpress/agent-application';
import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../agent/agent.tokens.js';
import { CurrentUser } from '../auth/current-user.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { AuthorizationService } from '../auth/authorization.service.js';
import { serializeDocument, type ArticleExportFormat } from './article-export.js';

type CreateArticleBody = {
  readonly title?: unknown;
  readonly folderId?: unknown;
};
type FolderBody = { readonly name?: unknown; readonly parentId?: unknown };
type MoveArticleBody = { readonly folderId?: unknown };
type ConversationBody = { readonly title?: unknown };

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
    @Inject(ConversationOverviewService)
    private readonly conversationOverviews: ConversationOverviewService,
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
      if (existing[0]) {
        await ensureWorkspaceDefaultConversation(transaction, existing[0].id);
        return existing[0];
      }
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
      await ensureWorkspaceDefaultConversation(transaction, workspaceId);
      return { id: workspaceId, name, role: 'owner' };
    });
  }

  @Get('workspaces/:workspaceId/articles')
  public async listArticles(
    @Param('workspaceId') workspaceId: string,
    @Query('trash') trash: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    const rows = await this.connection.db
      .select({
        id: articles.id,
        folderId: articles.folderId,
        title: articles.title,
        revisionId: articleRevisions.id,
        document: articleRevisions.document,
        updatedAt: articles.updatedAt,
      })
      .from(articles)
      .innerJoin(articleRevisions, eq(articleRevisions.id, articles.currentRevisionId))
      .where(
        and(
          eq(articles.workspaceId, workspaceId),
          trash === 'true' ? isNotNull(articles.deletedAt) : isNull(articles.deletedAt),
        ),
      )
      .orderBy(desc(articles.updatedAt));

    const conversationsByArticle = await this.connection.db
      .select({
        articleId: conversations.articleId,
        conversationId: conversations.id,
        branchId: conversationBranches.id,
        parentBranchId: conversationBranches.parentBranchId,
        forkedFromMessageId: conversationBranches.forkedFromMessageId,
        branchCreatedAt: conversationBranches.createdAt,
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

  @Get('workspaces/:workspaceId/folders')
  public async listFolders(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    return this.connection.db
      .select({
        id: contentFolders.id,
        parentId: contentFolders.parentId,
        name: contentFolders.name,
        position: contentFolders.position,
      })
      .from(contentFolders)
      .where(and(eq(contentFolders.workspaceId, workspaceId), isNull(contentFolders.deletedAt)))
      .orderBy(asc(contentFolders.position), asc(contentFolders.name));
  }

  @Post('workspaces/:workspaceId/folders')
  public async createFolder(
    @Param('workspaceId') workspaceId: string,
    @Body() body: FolderBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const name = validName(body.name, 'Folder name');
    const parentId = optionalId(body.parentId, 'parentId');
    await this.authorization.assertWorkspaceEditor(workspaceId, user.id);
    if (parentId) await this.assertFolder(workspaceId, parentId);
    const id = randomUUID();
    await this.connection.db.insert(contentFolders).values({ id, workspaceId, parentId, name });
    return { id, workspaceId, parentId, name, position: 0 };
  }

  @Patch('workspaces/:workspaceId/folders/:folderId')
  public async updateFolder(
    @Param('workspaceId') workspaceId: string,
    @Param('folderId') folderId: string,
    @Body() body: FolderBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceEditor(workspaceId, user.id);
    await this.assertFolder(workspaceId, folderId);
    const name = body.name === undefined ? undefined : validName(body.name, 'Folder name');
    const parentId =
      body.parentId === undefined ? undefined : optionalId(body.parentId, 'parentId');
    if (parentId === folderId) throw new BadRequestException('A folder cannot contain itself');
    if (parentId) {
      await this.assertFolder(workspaceId, parentId);
      if (await this.isDescendant(folderId, parentId))
        throw new BadRequestException('A folder cannot move into its descendant');
    }
    if (name === undefined && body.parentId === undefined)
      throw new BadRequestException('name or parentId is required');
    const rows = await this.connection.db
      .update(contentFolders)
      .set({ ...(name ? { name } : {}), ...(body.parentId !== undefined ? { parentId } : {}) })
      .where(and(eq(contentFolders.id, folderId), eq(contentFolders.workspaceId, workspaceId)))
      .returning({
        id: contentFolders.id,
        parentId: contentFolders.parentId,
        name: contentFolders.name,
      });
    return rows[0];
  }

  @Delete('workspaces/:workspaceId/folders/:folderId')
  public async deleteFolder(
    @Param('workspaceId') workspaceId: string,
    @Param('folderId') folderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceEditor(workspaceId, user.id);
    await this.assertFolder(workspaceId, folderId);
    const children = await this.connection.db
      .select({ id: contentFolders.id })
      .from(contentFolders)
      .where(and(eq(contentFolders.parentId, folderId), isNull(contentFolders.deletedAt)))
      .limit(1);
    if (children[0]) throw new ConflictException('Move or delete child folders first');
    const deletedAt = new Date();
    await this.connection.db.transaction(async (transaction) => {
      await transaction
        .update(articles)
        .set({ folderId: null, updatedAt: deletedAt })
        .where(eq(articles.folderId, folderId));
      await transaction
        .update(contentFolders)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(eq(contentFolders.id, folderId));
    });
    return { id: folderId, deletedAt: deletedAt.toISOString() };
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
    await this.authorization.assertWorkspaceEditor(workspaceId, user.id);
    const folderId = optionalId(body.folderId, 'folderId');
    if (folderId) await this.assertFolder(workspaceId, folderId);
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
      await transaction.insert(articles).values({ id: articleId, workspaceId, folderId, title });
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
        isDefault: true,
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
      folderId,
      title,
      revisionId,
      document,
      conversationId,
      branchId,
      updatedAt: new Date().toISOString(),
    };
  }

  @Get('articles/:articleId/conversations')
  public async listConversations(
    @Param('articleId') articleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertArticleAccess(articleId, user.id);
    return this.conversationOverviews.listForArticle(articleId, user.id);
  }

  @Get('workspaces/:workspaceId/conversations')
  public async listWorkspaceConversations(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    return this.conversationOverviews.listForWorkspace(workspaceId, user.id);
  }

  @Post('conversations/:conversationId/branches/:branchId/read')
  public async markConversationRead(
    @Param('conversationId') conversationId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertConversationBranchAccess(conversationId, branchId, user.id);
    await this.conversationOverviews.markRead(user.id, branchId);
    return { read: true };
  }

  @Post('articles/:articleId/conversations')
  public async createConversation(
    @Param('articleId') articleId: string,
    @Body() body: ConversationBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const workspaceId = await this.articleWorkspace(articleId);
    await this.authorization.assertWorkspaceEditor(workspaceId, user.id);
    const title =
      typeof body.title === 'string' && body.title.trim()
        ? body.title.trim().slice(0, 300)
        : '新对话';
    const id = randomUUID();
    const branchId = randomUUID();
    await this.connection.db.transaction(async (transaction) => {
      await transaction.insert(conversations).values({ id, workspaceId, articleId, title });
      await transaction.insert(conversationBranches).values({ id: branchId, conversationId: id });
    });
    return { id, articleId, title, branchId, isDefault: false };
  }

  @Post('workspaces/:workspaceId/conversations')
  public async createWorkspaceConversation(
    @Param('workspaceId') workspaceId: string,
    @Body() body: ConversationBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceEditor(workspaceId, user.id);
    return this.connection.db.transaction((transaction) =>
      createConversation(transaction, workspaceId, null, body.title),
    );
  }

  @Patch('conversations/:conversationId')
  public async updateConversation(
    @Param('conversationId') conversationId: string,
    @Body() body: ConversationBody & { readonly archived?: unknown },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const rows = await this.connection.db
      .select({ workspaceId: conversations.workspaceId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!rows[0]) throw new NotFoundException('Conversation does not exist');
    await this.authorization.assertWorkspaceEditor(rows[0].workspaceId, user.id);
    const title =
      body.title === undefined ? undefined : validName(body.title, 'Conversation title');
    const archivedAt =
      body.archived === undefined ? undefined : body.archived === true ? new Date() : null;
    if (title === undefined && archivedAt === undefined)
      throw new BadRequestException('title or archived is required');
    const updated = await this.connection.db
      .update(conversations)
      .set({
        ...(title ? { title } : {}),
        ...(archivedAt !== undefined ? { archivedAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId))
      .returning();
    return updated[0];
  }

  @Patch('articles/:articleId/location')
  public async moveArticle(
    @Param('articleId') articleId: string,
    @Body() body: MoveArticleBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const workspaceId = await this.articleWorkspace(articleId);
    await this.authorization.assertWorkspaceEditor(workspaceId, user.id);
    const folderId = optionalId(body.folderId, 'folderId');
    if (folderId) await this.assertFolder(workspaceId, folderId);
    const rows = await this.connection.db
      .update(articles)
      .set({ folderId, updatedAt: new Date() })
      .where(and(eq(articles.id, articleId), isNull(articles.deletedAt)))
      .returning({ id: articles.id, folderId: articles.folderId });
    if (!rows[0]) throw new NotFoundException('Article does not exist');
    return rows[0];
  }

  @Delete('articles/:articleId')
  public async trashArticle(
    @Param('articleId') articleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const workspaceId = await this.articleWorkspace(articleId);
    await this.authorization.assertWorkspaceEditor(workspaceId, user.id);
    const deletedAt = new Date();
    await this.connection.db
      .update(articles)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(eq(articles.id, articleId));
    return {
      id: articleId,
      deletedAt: deletedAt.toISOString(),
      purgeAfter: new Date(deletedAt.getTime() + 30 * 86_400_000).toISOString(),
    };
  }

  @Post('articles/:articleId/restore')
  public async restoreArticle(
    @Param('articleId') articleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const workspaceId = await this.articleWorkspace(articleId);
    await this.authorization.assertWorkspaceEditor(workspaceId, user.id);
    const rows = await this.connection.db
      .update(articles)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(articles.id, articleId))
      .returning({ id: articles.id });
    return rows[0];
  }

  @Get('articles/:articleId/revisions')
  public async listRevisions(
    @Param('articleId') articleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertArticleAccess(articleId, user.id);
    return this.connection.db
      .select({
        id: articleRevisions.id,
        revisionNumber: articleRevisions.revisionNumber,
        source: articleRevisions.source,
        documentHash: articleRevisions.documentHash,
        createdAt: articleRevisions.createdAt,
      })
      .from(articleRevisions)
      .where(eq(articleRevisions.articleId, articleId))
      .orderBy(desc(articleRevisions.revisionNumber));
  }

  @Get('articles/:articleId/export')
  public async exportArticle(
    @Param('articleId') articleId: string,
    @Query('format') format: string | undefined,
    @Query('revisionId') revisionId: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertArticleAccess(articleId, user.id);
    const selectedFormat = format ?? 'markdown';
    if (!['markdown', 'html', 'json'].includes(selectedFormat))
      throw new BadRequestException('format must be markdown, html or json');
    const rows = await this.connection.db
      .select({ title: articles.title, document: articleRevisions.document })
      .from(articles)
      .innerJoin(
        articleRevisions,
        and(
          eq(articleRevisions.articleId, articles.id),
          revisionId
            ? eq(articleRevisions.id, revisionId)
            : eq(articleRevisions.id, articles.currentRevisionId),
        ),
      )
      .where(eq(articles.id, articleId))
      .limit(1);
    const article = rows[0];
    if (!article) throw new NotFoundException('Article revision does not exist');
    return {
      filename: `${safeFilename(article.title)}.${selectedFormat === 'markdown' ? 'md' : selectedFormat}`,
      mimeType:
        selectedFormat === 'markdown'
          ? 'text/markdown; charset=utf-8'
          : selectedFormat === 'html'
            ? 'text/html; charset=utf-8'
            : 'application/json; charset=utf-8',
      content: serializeDocument(article.document, selectedFormat as ArticleExportFormat),
    };
  }

  private async assertFolder(workspaceId: string, folderId: string): Promise<void> {
    const rows = await this.connection.db
      .select({ id: contentFolders.id })
      .from(contentFolders)
      .where(
        and(
          eq(contentFolders.id, folderId),
          eq(contentFolders.workspaceId, workspaceId),
          isNull(contentFolders.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new NotFoundException('Folder does not exist in this workspace');
  }

  private async articleWorkspace(articleId: string): Promise<string> {
    const rows = await this.connection.db
      .select({ workspaceId: articles.workspaceId })
      .from(articles)
      .where(eq(articles.id, articleId))
      .limit(1);
    if (!rows[0]) throw new NotFoundException('Article does not exist');
    return rows[0].workspaceId;
  }

  private async isDescendant(folderId: string, candidateParentId: string): Promise<boolean> {
    let currentId: string | null = candidateParentId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      if (currentId === folderId) return true;
      visited.add(currentId);
      const rows = await this.connection.db
        .select({ parentId: contentFolders.parentId })
        .from(contentFolders)
        .where(eq(contentFolders.id, currentId))
        .limit(1);
      currentId = rows[0]?.parentId ?? null;
    }
    return false;
  }
}

export async function ensureWorkspaceDefaultConversation(
  transaction: DatabaseTransaction,
  workspaceId: string,
): Promise<void> {
  const existing = await transaction
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        isNull(conversations.articleId),
        eq(conversations.isDefault, true),
      ),
    )
    .limit(1);
  if (existing[0]) return;
  await createConversation(transaction, workspaceId, null, '写作助手', true);
}

async function createConversation(
  transaction: DatabaseTransaction,
  workspaceId: string,
  articleId: string | null,
  rawTitle: unknown,
  isDefault = false,
) {
  const title =
    typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 300) : '新对话';
  const id = randomUUID();
  const branchId = randomUUID();
  await transaction.insert(conversations).values({
    id,
    workspaceId,
    articleId,
    title,
    isDefault,
  });
  await transaction.insert(conversationBranches).values({ id: branchId, conversationId: id });
  return { id, articleId, title, branchId, isDefault };
}

function validName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 180)
    throw new BadRequestException(`${label} must contain between 1 and 180 characters`);
  return value.trim();
}

function optionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new BadRequestException(`${label} must be a UUID or null`);
  return value;
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '-').trim() || 'article';
}

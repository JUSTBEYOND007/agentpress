import { randomUUID } from 'node:crypto';

import {
  appUsers,
  articleRevisions,
  articles,
  enqueueOutboxMessage,
  mediaAssets,
  publicationEditions,
  publicationRankings,
  publicationReactions,
  publications,
  publicationViews,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, desc, eq, max, sql } from 'drizzle-orm';

import {
  PUBLICATION_EVENT_TOPIC,
  type PublicArticle,
  type PublicationEvent,
  type PublishArticleInput,
} from './contracts.js';

export class PublicationError extends Error {
  public constructor(
    public readonly code: 'not_found' | 'invalid_slug' | 'invalid_reaction',
    message: string,
  ) {
    super(message);
    this.name = 'PublicationError';
  }
}

export class PublicationService {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async publish(input: PublishArticleInput) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 180) {
      throw new PublicationError('invalid_slug', 'Slug must be lowercase kebab-case');
    }
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select ${articles.id} from ${articles} where ${articles.id} = ${input.articleId} for update`,
      );
      const rows = await transaction
        .select({
          articleId: articles.id,
          workspaceId: articles.workspaceId,
          title: articles.title,
          revisionId: articleRevisions.id,
          document: articleRevisions.document,
        })
        .from(articles)
        .innerJoin(
          articleRevisions,
          and(
            eq(articleRevisions.articleId, articles.id),
            eq(articleRevisions.id, input.revisionId),
          ),
        )
        .innerJoin(appUsers, eq(appUsers.id, input.userId))
        .where(eq(articles.id, input.articleId))
        .limit(1);
      const article = rows[0];
      if (!article) throw new PublicationError('not_found', 'Article revision or user not found');
      if (input.coverAssetId) {
        const cover = await transaction
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(
            and(
              eq(mediaAssets.id, input.coverAssetId),
              eq(mediaAssets.workspaceId, article.workspaceId),
            ),
          )
          .limit(1);
        if (!cover[0]) throw new PublicationError('not_found', 'Cover asset not found');
      }
      const numbers = await transaction
        .select({ value: max(publicationEditions.editionNumber) })
        .from(publicationEditions)
        .where(eq(publicationEditions.articleId, input.articleId));
      const editionId = this.createId();
      const publicationId = this.createId();
      const event = this.event('publication.published', publicationId);
      const editionNumber = (numbers[0]?.value ?? 0) + 1;
      await transaction.insert(publicationEditions).values({
        id: editionId,
        articleId: input.articleId,
        articleRevisionId: input.revisionId,
        editionNumber,
        titleSnapshot: article.title,
        documentSnapshot: article.document,
        coverAssetId: input.coverAssetId,
        createdByUserId: input.userId,
      });
      await transaction.insert(publications).values({
        id: publicationId,
        workspaceId: article.workspaceId,
        editionId,
        slug: input.slug,
        publishedAt: this.now(),
      });
      await transaction.insert(publicationRankings).values({ publicationId });
      await enqueueOutboxMessage(transaction, {
        id: event.messageId,
        aggregateType: 'publication',
        aggregateId: publicationId,
        topic: PUBLICATION_EVENT_TOPIC,
        messageKey: publicationId,
        payload: event,
        occurredAt: new Date(event.occurredAt),
      });
      return { publicationId, editionId, editionNumber, slug: input.slug };
    });
  }

  public async react(publicationId: string, userId: string, reaction: 'up' | 'down') {
    return this.database.transaction(async (transaction) => {
      const exists = await transaction
        .select({ id: publications.id })
        .from(publications)
        .innerJoin(appUsers, eq(appUsers.id, userId))
        .where(and(eq(publications.id, publicationId), eq(publications.status, 'published')))
        .limit(1);
      if (!exists[0]) throw new PublicationError('not_found', 'Publication or user not found');
      await transaction
        .insert(publicationReactions)
        .values({ publicationId, userId, reaction })
        .onConflictDoUpdate({
          target: [publicationReactions.publicationId, publicationReactions.userId],
          set: { reaction, updatedAt: this.now() },
        });
      await this.enqueueEvent(transaction, this.event('publication.reacted', publicationId));
      return { publicationId, reaction };
    });
  }

  public async recordView(publicationId: string, viewerHash: string) {
    const windowStartedAt = new Date(Math.floor(this.now().getTime() / 3_600_000) * 3_600_000);
    return this.database.transaction(async (transaction) => {
      const exists = await transaction
        .select({ id: publications.id })
        .from(publications)
        .where(and(eq(publications.id, publicationId), eq(publications.status, 'published')))
        .limit(1);
      if (!exists[0]) throw new PublicationError('not_found', 'Publication not found');
      const inserted = await transaction
        .insert(publicationViews)
        .values({ id: this.createId(), publicationId, viewerHash, windowStartedAt })
        .onConflictDoNothing()
        .returning({ id: publicationViews.id });
      if (inserted.length === 0) return { counted: false } as const;
      await this.enqueueEvent(transaction, this.event('publication.viewed', publicationId));
      return { counted: true } as const;
    });
  }

  public async findBySlug(slug: string): Promise<PublicArticle | undefined> {
    const rows = await this.baseQuery()
      .where(and(eq(publications.slug, slug), eq(publications.status, 'published')))
      .limit(1);
    return rows[0];
  }

  public async trending(limit = 20): Promise<readonly PublicArticle[]> {
    return this.baseQuery()
      .where(eq(publications.status, 'published'))
      .orderBy(desc(publicationRankings.score), desc(publications.publishedAt))
      .limit(Math.max(1, Math.min(limit, 50)));
  }

  private baseQuery() {
    return this.database
      .select({
        id: publications.id,
        slug: publications.slug,
        title: publicationEditions.titleSnapshot,
        document: publicationEditions.documentSnapshot,
        editionNumber: publicationEditions.editionNumber,
        publishedAt: publications.publishedAt,
        coverAssetId: publicationEditions.coverAssetId,
        coverObjectKey: mediaAssets.objectKey,
        coverAttribution: mediaAssets.attribution,
        score: publicationRankings.score,
        upvotes: publicationRankings.upvotes,
        downvotes: publicationRankings.downvotes,
        views: publicationRankings.views,
      })
      .from(publications)
      .innerJoin(publicationEditions, eq(publicationEditions.id, publications.editionId))
      .innerJoin(publicationRankings, eq(publicationRankings.publicationId, publications.id))
      .leftJoin(mediaAssets, eq(mediaAssets.id, publicationEditions.coverAssetId));
  }

  private event(type: PublicationEvent['type'], publicationId: string): PublicationEvent {
    return {
      messageId: this.createId(),
      type,
      publicationId,
      occurredAt: this.now().toISOString(),
    };
  }

  private async enqueueEvent(
    transaction: Parameters<typeof enqueueOutboxMessage>[0],
    event: PublicationEvent,
  ): Promise<void> {
    await enqueueOutboxMessage(transaction, {
      id: event.messageId,
      aggregateType: 'publication',
      aggregateId: event.publicationId,
      topic: PUBLICATION_EVENT_TOPIC,
      messageKey: event.publicationId,
      payload: event,
      occurredAt: new Date(event.occurredAt),
    });
  }
}

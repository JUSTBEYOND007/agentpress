export const PUBLICATION_EVENT_TOPIC = 'publication.events';
export const PUBLICATION_RANKING_CONSUMER_GROUP = 'agentpress-ranking-v1';

export type PublishArticleInput = {
  readonly articleId: string;
  readonly revisionId: string;
  readonly userId: string;
  readonly slug: string;
  readonly coverAssetId?: string;
};

export type PublicationEvent = {
  readonly messageId: string;
  readonly type:
    | 'publication.published'
    | 'publication.reacted'
    | 'publication.viewed'
    | 'publication.unpublished';
  readonly publicationId: string;
  readonly occurredAt: string;
};

export type ArticlePublication = {
  readonly id: string;
  readonly slug: string;
  readonly status: 'published' | 'unpublished';
  readonly editionNumber: number;
  readonly publishedAt: Date;
  readonly updatedAt: Date;
};

export type PublicArticle = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly editionNumber: number;
  readonly publishedAt: Date;
  readonly coverAssetId: string | null;
  readonly coverObjectKey: string | null;
  readonly coverAttribution: string | null;
  readonly score: number;
  readonly upvotes: number;
  readonly downvotes: number;
  readonly views: number;
};

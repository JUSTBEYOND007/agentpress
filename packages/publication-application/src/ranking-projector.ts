import {
  publicationRankings,
  publicationReactions,
  publicationViews,
  type DatabaseTransaction,
} from '@agentpress/database';
import { eq, sql } from 'drizzle-orm';

export async function projectPublicationRanking(
  transaction: DatabaseTransaction,
  publicationId: string,
): Promise<void> {
  const reactions = await transaction
    .select({
      upvotes: sql<number>`count(*) filter (where ${publicationReactions.reaction} = 'up')::int`,
      downvotes: sql<number>`count(*) filter (where ${publicationReactions.reaction} = 'down')::int`,
    })
    .from(publicationReactions)
    .where(eq(publicationReactions.publicationId, publicationId));
  const views = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(publicationViews)
    .where(eq(publicationViews.publicationId, publicationId));
  const upvotes = reactions[0]?.upvotes ?? 0;
  const downvotes = reactions[0]?.downvotes ?? 0;
  const viewCount = views[0]?.count ?? 0;
  const score = upvotes * 5 - downvotes * 3 + viewCount;
  await transaction
    .insert(publicationRankings)
    .values({ publicationId, upvotes, downvotes, views: viewCount, score, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: publicationRankings.publicationId,
      set: { upvotes, downvotes, views: viewCount, score, updatedAt: new Date() },
    });
}

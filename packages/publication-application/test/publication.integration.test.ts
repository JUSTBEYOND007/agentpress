import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  appUsers,
  articleRevisions,
  articles,
  connectDatabase,
  outboxMessages,
  publicationRankings,
  workspaces,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PublicationService, projectPublicationRanking } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('immutable publishing and engagement ranking', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    article: randomUUID(),
    revision: randomUUID(),
  };
  const service = new PublicationService(connection.db);

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `publisher|${ids.user}`,
      displayName: 'Publisher',
    });
    await connection.db.insert(workspaces).values({ id: ids.workspace, name: 'Publishing' });
    await connection.db.insert(articles).values({
      id: ids.article,
      workspaceId: ids.workspace,
      title: 'Published Agent Article',
    });
    await connection.db.insert(articleRevisions).values({
      id: ids.revision,
      articleId: ids.article,
      revisionNumber: 1,
      schemaVersion: 1,
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { blockId: 'intro' },
            content: [{ type: 'text', text: 'Immutable edition content.' }],
          },
        ],
      },
      documentHash: `sha256:${ids.revision}`,
      source: 'manual',
      createdByUserId: ids.user,
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('publishes an immutable edition and materializes deduplicated engagement', async () => {
    const published = await service.publish({
      articleId: ids.article,
      revisionId: ids.revision,
      userId: ids.user,
      slug: `agent-article-${ids.article}`,
    });
    await service.react(published.publicationId, ids.user, 'up');
    expect(await service.recordView(published.publicationId, 'viewer-hash')).toEqual({
      counted: true,
    });
    expect(await service.recordView(published.publicationId, 'viewer-hash')).toEqual({
      counted: false,
    });
    await connection.db.transaction((transaction) =>
      projectPublicationRanking(transaction, published.publicationId),
    );

    await expect(service.findBySlug(published.slug)).resolves.toMatchObject({
      editionNumber: 1,
      upvotes: 1,
      views: 1,
      score: 6,
    });
    expect(
      await connection.db
        .select()
        .from(publicationRankings)
        .where(eq(publicationRankings.publicationId, published.publicationId)),
    ).toHaveLength(1);
    expect(
      await connection.db
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.aggregateId, published.publicationId)),
    ).toHaveLength(3);
  });

  it('rejects views for publications that do not exist', async () => {
    await expect(service.recordView(randomUUID(), 'viewer-hash')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('unpublishes idempotently and removes the slug from public reads', async () => {
    const published = await service.publish({
      articleId: ids.article,
      revisionId: ids.revision,
      userId: ids.user,
      slug: `withdraw-${randomUUID()}`,
    });
    await expect(service.unpublish(ids.article, published.publicationId)).resolves.toMatchObject({
      status: 'unpublished',
    });
    await expect(service.unpublish(ids.article, published.publicationId)).resolves.toMatchObject({
      status: 'unpublished',
    });
    await expect(service.findBySlug(published.slug)).resolves.toBeUndefined();
  });

  it('serializes concurrent edition number allocation for one article', async () => {
    const suffix = randomUUID();
    const results = await Promise.all([
      service.publish({
        articleId: ids.article,
        revisionId: ids.revision,
        userId: ids.user,
        slug: `concurrent-a-${suffix}`,
      }),
      service.publish({
        articleId: ids.article,
        revisionId: ids.revision,
        userId: ids.user,
        slug: `concurrent-b-${suffix}`,
      }),
    ]);

    const editionNumbers = results.map((result) => result.editionNumber).sort((a, b) => a - b);
    expect(new Set(editionNumbers)).toHaveLength(2);
    expect((editionNumbers[1] ?? 0) - (editionNumbers[0] ?? 0)).toBe(1);
  });
});

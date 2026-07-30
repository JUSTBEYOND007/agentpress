import { fileURLToPath } from 'node:url';

import {
  articles,
  connectDatabase,
  conversations,
  publicationEditions,
  publications,
} from '@agentpress/database';
import { count, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEMO_IDS, seedDemo } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('demo seed', () => {
  const connection = connectDatabase(connectionString ?? '');

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('is idempotent and publishes the initial immutable edition', async () => {
    await seedDemo(connection.db);
    await seedDemo(connection.db);

    const articleCount = await connection.db
      .select({ value: count() })
      .from(articles)
      .where(eq(articles.id, DEMO_IDS.article));
    const publicationCount = await connection.db
      .select({ value: count() })
      .from(publications)
      .innerJoin(publicationEditions, eq(publications.editionId, publicationEditions.id))
      .where(eq(publicationEditions.articleId, DEMO_IDS.article));
    const linkedConversation = await connection.db
      .select({ articleId: conversations.articleId, title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, DEMO_IDS.conversation));
    expect(articleCount[0]?.value).toBe(1);
    expect(publicationCount[0]?.value).toBe(1);
    expect(linkedConversation[0]).toEqual({
      articleId: DEMO_IDS.article,
      title: '长文研究与修改',
    });
  });
});

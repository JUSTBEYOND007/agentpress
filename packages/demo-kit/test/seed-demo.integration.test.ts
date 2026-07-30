import { fileURLToPath } from 'node:url';

import { articles, connectDatabase, publications } from '@agentpress/database';
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
    const publicationCount = await connection.db.select({ value: count() }).from(publications);
    expect(articleCount[0]?.value).toBe(1);
    expect(publicationCount[0]?.value).toBe(1);
  });
});

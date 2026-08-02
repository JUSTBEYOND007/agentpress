import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { connectDatabase } from './postgres.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const connection = connectDatabase(connectionString);

try {
  await migrate(connection.db, {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
} finally {
  await connection.close();
}

import { connectDatabase } from '@agentpress/database';

import { seedDemo } from './seed-demo.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const connection = connectDatabase(connectionString);
try {
  const ids = await seedDemo(connection.db);
  process.stdout.write(`${JSON.stringify({ seeded: true, ids })}\n`);
} finally {
  await connection.close();
}

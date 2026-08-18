import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema.js';
import { assertVitestDatabaseIsolation } from './test-database-isolation.js';

export type AgentPressDatabase = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<AgentPressDatabase['transaction']>[0]>[0];

export type DatabaseConnection = {
  readonly db: AgentPressDatabase;
  readonly close: () => Promise<void>;
};

export function connectDatabase(connectionString: string): DatabaseConnection {
  assertVitestDatabaseIsolation(connectionString);
  const pool = new Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // node-postgres emits idle-client failures on the Pool in addition to
  // rejecting the active query/transaction. A listener is required to keep a
  // terminated backend from becoming an uncaught process exception.
  pool.on('error', () => undefined);
  pool.on('connect', (client) => {
    client.on('error', () => undefined);
  });

  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

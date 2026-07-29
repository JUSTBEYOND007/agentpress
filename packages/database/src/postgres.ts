import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema.js';

export type AgentPressDatabase = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<AgentPressDatabase['transaction']>[0]>[0];

export type DatabaseConnection = {
  readonly db: AgentPressDatabase;
  readonly close: () => Promise<void>;
};

export function connectDatabase(connectionString: string): DatabaseConnection {
  const pool = new Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

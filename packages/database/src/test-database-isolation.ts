import { randomUUID } from 'node:crypto';

export const TEST_DATABASE_PREFIX = 'agentpress_test_';
const TEST_DATABASE_ENVIRONMENT = 'AGENTPRESS_TEST_DATABASE_NAME';

export function createTemporaryTestDatabaseName(
  now: number = Date.now(),
  processId: number = process.pid,
  nonce: string = randomUUID(),
): string {
  const suffix = nonce.replaceAll('-', '').slice(0, 12);
  return `${TEST_DATABASE_PREFIX}${String(now)}_${String(processId)}_${suffix}`.slice(0, 63);
}

export function replaceDatabaseName(connectionString: string, databaseName: string): string {
  const url = parsePostgresUrl(connectionString);
  url.pathname = `/${databaseName}`;
  url.searchParams.delete('options');
  return url.toString();
}

export function databaseNameFromConnectionString(connectionString: string): string {
  const url = parsePostgresUrl(connectionString);
  return decodeURIComponent(url.pathname.slice(1));
}

export function assertVitestDatabaseIsolation(
  connectionString: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.VITEST !== 'true') return;

  const expectedDatabaseName = environment[TEST_DATABASE_ENVIRONMENT];
  const actualDatabaseName = databaseNameFromConnectionString(connectionString);
  if (
    !expectedDatabaseName?.startsWith(TEST_DATABASE_PREFIX) ||
    actualDatabaseName !== expectedDatabaseName
  ) {
    throw new Error(
      'Integration tests must use the isolated test database runner. Run the package test:integration script instead of connecting Vitest to the development database.',
    );
  }
}

function parsePostgresUrl(connectionString: string): URL {
  const url = new URL(connectionString);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL connection URL must use postgres: or postgresql:');
  }
  if (!url.pathname || url.pathname === '/') {
    throw new Error('PostgreSQL connection URL must include a database name');
  }
  return url;
}

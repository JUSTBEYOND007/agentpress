import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import {
  createTemporaryTestDatabaseName,
  replaceDatabaseName,
} from '../src/test-database-isolation.js';

const sourceDatabaseUrl = process.env.DATABASE_URL;
if (!sourceDatabaseUrl) {
  throw new Error('DATABASE_URL is required to create an isolated integration test database');
}

const testFiles = process.argv.slice(2);
if (testFiles.length === 0) {
  throw new Error('At least one Vitest file pattern is required');
}

const databaseName = createTemporaryTestDatabaseName();
const admin = new Client({ connectionString: replaceDatabaseName(sourceDatabaseUrl, 'postgres') });
await admin.connect();

let created = false;
try {
  await admin.query(`create database "${databaseName}"`);
  created = true;
  const exitCode = await runVitest(
    replaceDatabaseName(sourceDatabaseUrl, databaseName),
    databaseName,
  );
  process.exitCode = exitCode;
} finally {
  if (created) {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  }
  await admin.end();
}

async function runVitest(databaseUrl: string, isolatedDatabaseName: string): Promise<number> {
  const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
  const child = spawn(process.execPath, [vitest, 'run', ...testFiles, '--maxWorkers=1'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENTPRESS_TEST_DATABASE_NAME: isolatedDatabaseName,
      DATABASE_URL: databaseUrl,
    },
    stdio: 'inherit',
  });

  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

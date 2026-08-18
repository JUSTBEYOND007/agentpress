import { describe, expect, it } from 'vitest';

import {
  assertVitestDatabaseIsolation,
  createTemporaryTestDatabaseName,
  databaseNameFromConnectionString,
  replaceDatabaseName,
  TEST_DATABASE_PREFIX,
} from '../src/test-database-isolation.js';

describe('integration test database isolation', () => {
  it('creates a bounded PostgreSQL database identifier', () => {
    const name = createTemporaryTestDatabaseName(123, 456, '12345678-1234-1234-1234-123456789abc');

    expect(name).toBe('agentpress_test_123_456_123456781234');
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('replaces only the database target and drops inherited search path options', () => {
    const replaced = replaceDatabaseName(
      'postgresql://agentpress:secret@localhost:5432/agentpress?sslmode=disable&options=-csearch_path%3Dpublic',
      'agentpress_test_example',
    );

    expect(databaseNameFromConnectionString(replaced)).toBe('agentpress_test_example');
    expect(new URL(replaced).searchParams.get('sslmode')).toBe('disable');
    expect(new URL(replaced).searchParams.has('options')).toBe(false);
  });

  it('allows application connections outside Vitest', () => {
    expect(() => {
      assertVitestDatabaseIsolation('postgresql://localhost/agentpress', {});
    }).not.toThrow();
  });

  it('allows the temporary database selected by the isolated runner', () => {
    const databaseName = `${TEST_DATABASE_PREFIX}verified`;

    expect(() => {
      assertVitestDatabaseIsolation(`postgresql://localhost/${databaseName}`, {
        VITEST: 'true',
        AGENTPRESS_TEST_DATABASE_NAME: databaseName,
      });
    }).not.toThrow();
  });

  it('rejects a direct Vitest connection to the development database', () => {
    expect(() => {
      assertVitestDatabaseIsolation('postgresql://localhost/agentpress', { VITEST: 'true' });
    }).toThrow(/isolated test database runner/);
  });

  it('rejects a mismatched database even when an isolation marker is present', () => {
    expect(() => {
      assertVitestDatabaseIsolation('postgresql://localhost/agentpress', {
        VITEST: 'true',
        AGENTPRESS_TEST_DATABASE_NAME: `${TEST_DATABASE_PREFIX}other`,
      });
    }).toThrow(/isolated test database runner/);
  });
});

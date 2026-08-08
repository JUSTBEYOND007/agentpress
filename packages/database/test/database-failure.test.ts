import { describe, expect, it } from 'vitest';

import { isDatabaseConnectionFailure } from '../src/database-failure.js';

describe('database connection failure classification', () => {
  it.each(['08006', '57P01', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'])(
    'accepts structured connection code %s',
    (code) => {
      expect(
        isDatabaseConnectionFailure(Object.assign(new Error('private detail'), { code })),
      ).toBe(true);
    },
  );

  it('walks bounded causes but ignores messages and ordinary SQL failures', () => {
    expect(
      isDatabaseConnectionFailure(
        Object.assign(new Error('wrapper'), {
          cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
        }),
      ),
    ).toBe(true);
    expect(isDatabaseConnectionFailure(new Error('connection reset ECONNRESET'))).toBe(false);
    expect(
      isDatabaseConnectionFailure(Object.assign(new Error('foreign key'), { code: '23503' })),
    ).toBe(false);
  });

  it('treats a failed rollback query as a lost transaction connection', () => {
    expect(
      isDatabaseConnectionFailure({
        query: 'rollback',
        cause: new Error('driver omitted a connection code'),
      }),
    ).toBe(true);
    expect(isDatabaseConnectionFailure({ query: 'insert into articles values ($1)' })).toBe(false);
  });
});

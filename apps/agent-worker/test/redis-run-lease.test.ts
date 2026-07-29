import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { RedisRunLeaseManager } from '../src/redis-run-lease.js';

describe('RedisRunLeaseManager', () => {
  it('uses fencing tokens so only the current owner can release a Run', async () => {
    const values = new Map<string, string>();
    const redis = {
      set(key: string, value: string) {
        if (values.has(key)) {
          return Promise.resolve(null);
        }
        values.set(key, value);
        return Promise.resolve('OK');
      },
      eval(script: string, _keys: number, key: string, token: string) {
        if (values.get(key) !== token) {
          return Promise.resolve(0);
        }
        if (script.includes("redis.call('del'")) {
          values.delete(key);
        }
        return Promise.resolve(1);
      },
    } as unknown as Redis;
    const manager = new RedisRunLeaseManager(redis, { ttlMs: 60_000 });
    const first = await manager.acquire('run-1', () => undefined);
    expect(first).toBeDefined();
    await expect(manager.acquire('run-1', () => undefined)).resolves.toBeUndefined();
    await first?.release();
    const next = await manager.acquire('run-1', () => undefined);
    expect(next).toBeDefined();
    await next?.release();
  });
});

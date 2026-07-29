import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export type RunLease = {
  readonly runId: string;
  readonly token: string;
  release(): Promise<void>;
};

export class RedisRunLeaseManager {
  public constructor(
    private readonly redis: Redis,
    private readonly options: {
      readonly ttlMs?: number;
      readonly keyPrefix?: string;
      readonly createToken?: () => string;
    } = {},
  ) {}

  public async acquire(runId: string, onLost: () => void): Promise<RunLease | undefined> {
    const ttlMs = this.options.ttlMs ?? 30_000;
    const key = `${this.options.keyPrefix ?? 'agentpress:run:lease:'}${runId}`;
    const token = (this.options.createToken ?? randomUUID)();
    const acquired = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') {
      return undefined;
    }
    let released = false;
    let renewing = false;
    const timer = setInterval(
      () => {
        if (renewing || released) {
          return;
        }
        renewing = true;
        void this.redis
          .eval(RENEW_SCRIPT, 1, key, token, String(ttlMs))
          .then((result) => {
            if (result !== 1 && !released) {
              released = true;
              clearInterval(timer);
              onLost();
            }
          })
          .catch(() => {
            if (!released) {
              released = true;
              clearInterval(timer);
              onLost();
            }
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(250, Math.floor(ttlMs / 3)),
    );
    timer.unref();

    return {
      runId,
      token,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        clearInterval(timer);
        await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
      },
    };
  }
}

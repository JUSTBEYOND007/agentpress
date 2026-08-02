import type { Redis } from 'ioredis';
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
export class RedisWriterLease {
  public constructor(
    private readonly redis: Redis,
    private readonly ttlMs = 30_000,
  ) {}
  public async acquire(articleId: string, userId: string, leaseId: string): Promise<boolean> {
    return (await this.redis.set(key(articleId, userId), leaseId, 'PX', this.ttlMs, 'NX')) === 'OK';
  }
  public async owns(articleId: string, userId: string, leaseId: string): Promise<boolean> {
    return (await this.redis.get(key(articleId, userId))) === leaseId;
  }
  public async renew(articleId: string, userId: string, leaseId: string): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(RENEW, 1, key(articleId, userId), leaseId, String(this.ttlMs)),
      ) === 1
    );
  }
  public async release(articleId: string, userId: string, leaseId: string): Promise<boolean> {
    return Number(await this.redis.eval(RELEASE, 1, key(articleId, userId), leaseId)) === 1;
  }
}
function key(articleId: string, userId: string): string {
  return `agentpress:article:${articleId}:writer:${userId}`;
}

import { createHash } from 'node:crypto';

export function executionFactKey(input: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export class ExecutionFactCache<T> {
  private readonly values = new Map<string, T>();

  public constructor(private readonly limit = 64) {}

  public get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value !== undefined) {
      this.values.delete(key);
      this.values.set(key, value);
    }
    return value;
  }

  public set(key: string, value: T): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }
}

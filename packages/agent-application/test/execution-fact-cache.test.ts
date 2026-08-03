import { describe, expect, it } from 'vitest';
import { ExecutionFactCache, executionFactKey } from '../src/execution-fact-cache.js';

describe('execution fact cache', () => {
  it('changes the key when a durable fact changes', () => {
    expect(executionFactKey({ runId: 'run', eventSequence: 1 })).not.toBe(
      executionFactKey({ runId: 'run', eventSequence: 2 }),
    );
  });

  it('evicts the least recently used projection at the bound', () => {
    const cache = new ExecutionFactCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
  });
});

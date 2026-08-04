import { describe, expect, it } from 'vitest';

import { ToolLoopGuard } from '../src/tool-loop-guard.js';

describe('ToolLoopGuard', () => {
  it('allows bounded retries and blocks only the next identical call', () => {
    const guard = new ToolLoopGuard(2);
    expect(guard.observe('search', { q: 'pi' })).toMatchObject({ allow: true, consecutive: 1 });
    expect(guard.observe('search', { q: 'pi' })).toMatchObject({ allow: true, consecutive: 2 });
    expect(guard.observe('search', { q: 'pi' })).toMatchObject({ allow: false, consecutive: 3 });
  });

  it('resets after a different tool or canonical argument change', () => {
    const guard = new ToolLoopGuard(2);
    guard.observe('search', { q: 'pi', page: 1 });
    guard.observe('search', { page: 1, q: 'pi' });
    expect(guard.observe('search', { q: 'pi', page: 2 })).toMatchObject({
      allow: true,
      consecutive: 1,
    });
    expect(guard.observe('fetch', { q: 'pi', page: 2 })).toMatchObject({
      allow: true,
      consecutive: 1,
    });
  });
});

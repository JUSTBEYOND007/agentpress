import { describe, expect, it } from 'vitest';

import { createServiceLogger } from '../src/index.js';

describe('createServiceLogger', () => {
  it('creates a logger with the configured level', () => {
    expect(createServiceLogger({ level: 'warn', service: 'api' }).level).toBe('warn');
  });
});

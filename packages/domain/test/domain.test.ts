import { describe, expect, it } from 'vitest';

import { PRODUCT_NAME } from '../src/index.js';

describe('domain', () => {
  it('exposes the canonical product name', () => {
    expect(PRODUCT_NAME).toBe('AgentPress');
  });
});

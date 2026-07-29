import { describe, expect, it } from 'vitest';

import { loadApiEnvironment } from '../src/index.js';

describe('loadApiEnvironment', () => {
  it('provides local defaults', () => {
    expect(loadApiEnvironment({})).toEqual({
      logLevel: 'info',
      nodeEnv: 'development',
      port: 4000,
    });
  });

  it('rejects an invalid port', () => {
    expect(() => loadApiEnvironment({ API_PORT: '70000' })).toThrow(
      'API_PORT must be an integer between 1 and 65535',
    );
  });
});

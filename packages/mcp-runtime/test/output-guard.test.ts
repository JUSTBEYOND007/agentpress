import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { guardMcpOutput } from '../src/index.js';

describe('MCP output guard', () => {
  it('redacts credentials and validates bounded output', () => {
    const result = guardMcpOutput(
      { title: 'Article', apiKey: 'secret', nested: { access_token: 'token' } },
      {
        outputSchema: Type.Object({
          title: Type.String(),
          apiKey: Type.String(),
          nested: Type.Object({ access_token: Type.String() }),
        }),
      },
    );
    expect(result.redactions).toBe(2);
    expect(result.value).toMatchObject({ apiKey: '[REDACTED]' });
  });

  it('rejects oversized output', () => {
    expect(() => guardMcpOutput({ text: 'x'.repeat(20) }, undefined, 10)).toThrow(/exceeds/);
  });

  it('rejects schema mismatch after redaction', () => {
    expect(() =>
      guardMcpOutput({ count: 'wrong' }, { outputSchema: Type.Object({ count: Type.Number() }) }),
    ).toThrow(/schema/);
  });
});

import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { guardMcpOutput, guardMcpOutputWithArtifact } from '../src/index.js';

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

  it('externalizes oversized output and returns only a bounded summary and reference', async () => {
    const full = { text: 'x'.repeat(2_000), password: 'private' };
    let persisted: unknown;
    const result = await guardMcpOutputWithArtifact(full, undefined, {
      maxBytes: 100,
      writeArtifact: (input) => {
        persisted = input.value;
        return Promise.resolve({
          artifactId: 'artifact-1',
          versionId: 'version-1',
          contentHash: 'hash-1',
          bytes: input.bytes,
          uri: 'artifact://artifact-1/versions/1',
        });
      },
    });
    expect(persisted).toMatchObject({ password: '[REDACTED]' });
    expect(result.artifact).toMatchObject({ artifactId: 'artifact-1' });
    expect(result.value).toMatchObject({
      artifactId: 'artifact-1',
      uri: 'artifact://artifact-1/versions/1',
    });
    expect(JSON.stringify(result.value).length).toBeLessThan(1_300);
    expect(JSON.stringify(result.value)).not.toContain('private');
  });
});

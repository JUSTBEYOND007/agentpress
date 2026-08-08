import { describe, expect, it } from 'vitest';

import { boundedEvidenceReferences } from '../src/tool-call-output-references.js';

describe('ToolCall output references', () => {
  it('bounds Evidence reference count and consumer-visible fields', () => {
    const oversized = 'x'.repeat(500);
    const references = Array.from({ length: 40 }, (_, index) => ({
      evidenceId: `${String(index)}-${oversized}`,
      title: oversized,
      source: `https://example.test/${oversized}`,
      sourceRevision: oversized,
    }));

    const projected = boundedEvidenceReferences(references);

    expect(projected).toHaveLength(32);
    expect(projected[0]).toMatchObject({ evidenceId: `0-${'x'.repeat(238)}` });
    expect(
      projected.every((reference) =>
        Object.values(reference).every((value) => value.length <= 240),
      ),
    ).toBe(true);
  });
});

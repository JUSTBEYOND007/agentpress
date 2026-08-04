import { describe, expect, it } from 'vitest';

import { composePromptBlocks, renderPromptTemplate } from '../src/prompt.js';
import { createPromptRevision, promptSnapshotsEqual } from '../src/policy.js';

describe('prompt composition', () => {
  it('renders explicit variables and preserves block order', () => {
    expect(
      composePromptBlocks([
        { id: 'role', content: 'You are a writer.' },
        { id: 'context', content: renderPromptTemplate('Date: {{date}}', { date: '2026-08-04' }) },
        { id: 'disabled', content: 'ignore', enabled: false },
      ]),
    ).toBe('You are a writer.\n\nDate: 2026-08-04');
  });

  it('fails closed on missing variables, duplicate IDs, and empty blocks', () => {
    expect(() => renderPromptTemplate('Use {{missing}}.', {})).toThrow('missing');
    expect(() =>
      composePromptBlocks([
        { id: 'same', content: 'a' },
        { id: 'same', content: 'b' },
      ]),
    ).toThrow('duplicated');
    expect(() => composePromptBlocks([{ id: 'empty', content: ' ' }])).toThrow('empty');
  });

  it('detects composition drift independently from rendered prompt content', () => {
    const source = {
      templateVersion: 'writer@1',
      variableSchemaVersion: 'writer-vars@1',
      blocks: [{ id: 'role', content: 'Write clearly.' }],
    } as const;
    const first = createPromptRevision('writer', '1', 'Write clearly.', source);
    const changedComposition = createPromptRevision('writer', '1', 'Write clearly.', {
      ...source,
      blocks: [{ id: 'policy', content: 'Write clearly.' }],
    });
    expect(first.contentHash).toBe(changedComposition.contentHash);
    expect(first.snapshotHash).not.toBe(changedComposition.snapshotHash);
    expect(promptSnapshotsEqual(first.snapshot, changedComposition.snapshot)).toBe(false);
    expect(promptSnapshotsEqual(first.snapshot, { ...first.snapshot })).toBe(true);
    expect(promptSnapshotsEqual({ ...first.snapshot, schemaVersion: 2 }, first.snapshot)).toBe(
      false,
    );
  });

  it('rejects ambiguous prompt snapshot blocks', () => {
    expect(() => {
      createPromptRevision('writer', '1', 'Write', {
        templateVersion: 'writer@1',
        variableSchemaVersion: 'writer-vars@1',
        blocks: [
          { id: 'role', content: 'one' },
          { id: 'role', content: 'two' },
        ],
      });
    }).toThrow('unique IDs');
  });
});

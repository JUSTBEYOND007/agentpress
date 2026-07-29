import { describe, expect, it } from 'vitest';
import { applyAutosaveSteps } from '../src/index.js';
describe('ProseMirror autosave steps', () => {
  it('applies ordered JSON steps with the shared Tiptap schema', () => {
    const document = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { blockId: 'a' }, content: [{ type: 'text', text: 'Old' }] },
      ],
    };
    expect(
      applyAutosaveSteps(document, [
        {
          stepType: 'replace',
          from: 1,
          to: 4,
          slice: { content: [{ type: 'text', text: 'New' }] },
        },
      ]),
    ).toMatchObject({ content: [{ content: [{ text: 'New' }] }] });
  });
  it('rejects empty and oversized batches', () => {
    expect(() => applyAutosaveSteps({ type: 'doc', content: [] }, [])).toThrow(/between 1 and 200/);
  });
});

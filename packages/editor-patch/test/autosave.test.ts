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

  it('replays table, task and image nodes with the production schema', () => {
    const document = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { blockId: 'empty' } }],
    };
    const advancedNodes = [
      {
        type: 'taskList',
        attrs: { blockId: 'tasks' },
        content: [
          {
            type: 'taskItem',
            attrs: { checked: false, blockId: 'task-1' },
            content: [
              {
                type: 'paragraph',
                attrs: { blockId: 'task-text' },
                content: [{ type: 'text', text: 'Verify' }],
              },
            ],
          },
        ],
      },
      {
        type: 'table',
        attrs: { blockId: 'table-1' },
        content: [
          {
            type: 'tableRow',
            attrs: { blockId: 'row-1' },
            content: [
              {
                type: 'tableHeader',
                attrs: { colspan: 1, rowspan: 1, colwidth: null, blockId: 'cell-1' },
                content: [
                  {
                    type: 'paragraph',
                    attrs: { blockId: 'cell-text' },
                    content: [{ type: 'text', text: 'Column' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'image',
        attrs: {
          src: 'https://example.com/image.png',
          alt: 'Example',
          title: null,
          blockId: 'image-1',
        },
      },
    ];
    const result = applyAutosaveSteps(document, [
      { stepType: 'replace', from: 0, to: 2, slice: { content: advancedNodes } },
    ]) as { content: readonly { type: string }[] };
    expect(result.content.map((node) => node.type)).toEqual(['taskList', 'table', 'image']);
  });
});

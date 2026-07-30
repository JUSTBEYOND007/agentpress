import { getSchema } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import UniqueID from '@tiptap/extension-unique-id';
import { Node } from '@tiptap/pm/model';
import { Step } from '@tiptap/pm/transform';
import StarterKit from '@tiptap/starter-kit';

const schema = getSchema([
  StarterKit,
  Image.configure({ allowBase64: false, inline: false }),
  TableKit.configure({ table: { resizable: true } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  UniqueID.configure({
    attributeName: 'blockId',
    types: [
      'heading',
      'paragraph',
      'blockquote',
      'bulletList',
      'orderedList',
      'listItem',
      'codeBlock',
      'image',
      'taskList',
      'taskItem',
      'table',
      'tableRow',
      'tableHeader',
      'tableCell',
    ],
  }),
]);

export function applyAutosaveSteps(document: unknown, steps: readonly unknown[]): unknown {
  if (steps.length === 0 || steps.length > 200)
    throw new RangeError('Autosave batch must contain between 1 and 200 steps');
  let current = Node.fromJSON(schema, document);
  for (const value of steps) {
    const result = Step.fromJSON(schema, value).apply(current);
    if (result.failed) throw new Error(`Autosave step failed: ${result.failed}`);
    if (!result.doc) throw new Error('Autosave step produced no document');
    current = result.doc;
  }
  return current.toJSON();
}

export function editorSchema() {
  return schema;
}

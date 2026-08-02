'use client';

import type { Editor } from '@tiptap/core';
import {
  Bold,
  Braces,
  Code2,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Redo2,
  Table2,
  Undo2,
} from 'lucide-react';

type EditorCommand = {
  readonly label: string;
  readonly icon: React.JSX.Element;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly run: () => void;
};

export function EditorToolbar({ editor }: { readonly editor: Editor }): React.JSX.Element {
  const commands: readonly EditorCommand[] = [
    command(
      '一级标题',
      <Heading1 size={15} />,
      () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      editor.isActive('heading', { level: 1 }),
    ),
    command(
      '二级标题',
      <Heading2 size={15} />,
      () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      editor.isActive('heading', { level: 2 }),
    ),
    command(
      '粗体',
      <Bold size={15} />,
      () => editor.chain().focus().toggleBold().run(),
      editor.isActive('bold'),
    ),
    command(
      '斜体',
      <Italic size={15} />,
      () => editor.chain().focus().toggleItalic().run(),
      editor.isActive('italic'),
    ),
    command(
      '项目列表',
      <List size={15} />,
      () => editor.chain().focus().toggleBulletList().run(),
      editor.isActive('bulletList'),
    ),
    command(
      '编号列表',
      <ListOrdered size={15} />,
      () => editor.chain().focus().toggleOrderedList().run(),
      editor.isActive('orderedList'),
    ),
    command(
      '任务清单',
      <ListTodo size={15} />,
      () => editor.chain().focus().toggleTaskList().run(),
      editor.isActive('taskList'),
    ),
    command(
      '引用',
      <Quote size={15} />,
      () => editor.chain().focus().toggleBlockquote().run(),
      editor.isActive('blockquote'),
    ),
    command(
      '代码块',
      <Code2 size={15} />,
      () => editor.chain().focus().toggleCodeBlock().run(),
      editor.isActive('codeBlock'),
    ),
    command(
      '行内代码',
      <Braces size={15} />,
      () => editor.chain().focus().toggleCode().run(),
      editor.isActive('code'),
    ),
    command('分隔线', <Minus size={15} />, () => editor.chain().focus().setHorizontalRule().run()),
    command('插入表格', <Table2 size={15} />, () =>
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    ),
    command(
      '添加链接',
      <Link size={15} />,
      () => {
        setLink(editor);
      },
      editor.isActive('link'),
    ),
    command('插入图片', <ImagePlus size={15} />, () => {
      insertImage(editor);
    }),
    command(
      '撤销',
      <Undo2 size={15} />,
      () => editor.chain().focus().undo().run(),
      false,
      !editor.can().undo(),
    ),
    command(
      '重做',
      <Redo2 size={15} />,
      () => editor.chain().focus().redo().run(),
      false,
      !editor.can().redo(),
    ),
  ];
  return (
    <div className="editor-toolbar" aria-label="编辑工具栏">
      {commands.map((item) => (
        <button
          aria-label={item.label}
          className={item.active ? 'is-active' : ''}
          disabled={item.disabled}
          key={item.label}
          onClick={item.run}
          title={item.label}
          type="button"
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}

export const slashCommands = [
  {
    label: '一级标题',
    keywords: 'h1 title',
    run: (editor: Editor) =>
      editor
        .chain()
        .focus()
        .deleteRange({ from: editor.state.selection.from - 1, to: editor.state.selection.from })
        .toggleHeading({ level: 1 })
        .run(),
  },
  {
    label: '二级标题',
    keywords: 'h2 subtitle',
    run: (editor: Editor) =>
      editor
        .chain()
        .focus()
        .deleteRange({ from: editor.state.selection.from - 1, to: editor.state.selection.from })
        .toggleHeading({ level: 2 })
        .run(),
  },
  {
    label: '任务清单',
    keywords: 'todo task',
    run: (editor: Editor) =>
      editor
        .chain()
        .focus()
        .deleteRange({ from: editor.state.selection.from - 1, to: editor.state.selection.from })
        .toggleTaskList()
        .run(),
  },
  {
    label: '表格',
    keywords: 'table',
    run: (editor: Editor) =>
      editor
        .chain()
        .focus()
        .deleteRange({ from: editor.state.selection.from - 1, to: editor.state.selection.from })
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    label: '代码块',
    keywords: 'code',
    run: (editor: Editor) =>
      editor
        .chain()
        .focus()
        .deleteRange({ from: editor.state.selection.from - 1, to: editor.state.selection.from })
        .toggleCodeBlock()
        .run(),
  },
] as const;

function command(
  label: string,
  icon: React.JSX.Element,
  run: () => void,
  active = false,
  disabled = false,
): EditorCommand {
  return { label, icon, run, active, disabled };
}

function setLink(editor: Editor): void {
  if (editor.isActive('link')) {
    editor.chain().focus().unsetLink().run();
    return;
  }
  const href = window.prompt('输入链接地址（https://）');
  if (href?.startsWith('https://') || href?.startsWith('http://'))
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

function insertImage(editor: Editor): void {
  const source = window.prompt('输入图片地址（https://）');
  if (source?.startsWith('https://') || source?.startsWith('http://'))
    editor.chain().focus().setImage({ src: source }).run();
}

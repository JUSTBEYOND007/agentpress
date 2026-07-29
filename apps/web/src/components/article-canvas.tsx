'use client';

import UniqueID from '@tiptap/extension-unique-id';
import { Step } from '@tiptap/pm/transform';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState } from 'react';
import { acknowledgeAutosave, enqueueAutosave, listPendingAutosaves } from '../lib/autosave-queue';

const articleId = process.env.NEXT_PUBLIC_DEMO_ARTICLE_ID ?? 'local-demo';
const userId = process.env.NEXT_PUBLIC_DEMO_USER_ID;
const baseRevisionId = process.env.NEXT_PUBLIC_DEMO_REVISION_ID;
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export function ArticleCanvas(): React.JSX.Element {
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'offline'>('saved');
  const leaseId = useRef(crypto.randomUUID());
  const chain = useRef(Promise.resolve());
  const clientSequence = useRef(0);
  const isRecovering = useRef(false);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
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
        ],
      }),
    ],
    content: initialContent(),
    onTransaction: ({ transaction }) => {
      if (!transaction.docChanged || isRecovering.current) return;
      const steps = transaction.steps.map((step): unknown => step.toJSON() as unknown);
      const updateId = crypto.randomUUID();
      clientSequence.current += 1;
      const sequence = clientSequence.current;
      setSaveState('saving');
      chain.current = chain.current
        .then(async () => {
          await enqueueAutosave({
            updateId,
            articleId,
            steps,
            createdAt: Date.now(),
            clientSequence: sequence,
          });
          if (!userId || !baseRevisionId) {
            setSaveState('offline');
            return;
          }
          const response = await fetch(`${apiUrl}/articles/${articleId}/autosave`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              updateId,
              userId,
              writerLeaseId: leaseId.current,
              baseRevisionId,
              schemaVersion: 1,
              steps,
            }),
          });
          if (!response.ok) {
            setSaveState('offline');
            return;
          }
          await acknowledgeAutosave(updateId);
          setSaveState('saved');
        })
        .catch(() => {
          setSaveState('offline');
        });
    },
  });

  useEffect(() => {
    if (!editor) return;
    let active = true;
    void listPendingAutosaves(articleId)
      .then((pending) => {
        if (!active || pending.length === 0) return;
        let transaction = editor.state.tr;
        for (const batch of pending)
          for (const value of batch.steps)
            transaction = transaction.step(Step.fromJSON(editor.state.schema, value));
        isRecovering.current = true;
        try {
          editor.view.dispatch(transaction);
        } finally {
          isRecovering.current = false;
        }
        setSaveState('offline');
      })
      .catch(() => {
        setSaveState('offline');
      });
    return () => {
      active = false;
    };
  }, [editor]);
  useEffect(() => {
    if (!userId || !baseRevisionId) return;
    const body = (action: string) =>
      fetch(`${apiUrl}/articles/${articleId}/writer-lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, userId, leaseId: leaseId.current }),
      });
    void body('acquire');
    const timer = window.setInterval(() => void body('renew'), 10_000);
    return () => {
      window.clearInterval(timer);
      void body('release');
    };
  }, []);

  return (
    <section className="article-editor-shell">
      <div className={`save-state save-${saveState}`} aria-live="polite">
        {saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中' : '本地草稿'}
      </div>
      <EditorContent className="article-canvas" editor={editor} />
    </section>
  );
}

function initialContent() {
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1, blockId: 'title' },
        content: [{ type: 'text', text: 'Agent 时代的长文创作' }],
      },
      {
        type: 'paragraph',
        attrs: { blockId: 'lead' },
        content: [
          {
            type: 'text',
            text: '好的写作工具不应该替作者做决定，而应该让研究、组织、修改和核验都变得可见、可控。',
          },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 2, blockId: 'section-1' },
        content: [{ type: 'text', text: '从一次回答变成一次可靠执行' }],
      },
      {
        type: 'paragraph',
        attrs: { blockId: 'body-1' },
        content: [
          {
            type: 'text',
            text: '当任务涉及联网检索、资料引用和文章修改时，系统会先生成计划，再把边界清晰的任务交给不同 Specialist。每一步都留下来源、状态和恢复点。',
          },
        ],
      },
      {
        type: 'blockquote',
        attrs: { blockId: 'quote-1' },
        content: [
          {
            type: 'paragraph',
            attrs: { blockId: 'quote-text' },
            content: [
              {
                type: 'text',
                text: 'Agent 的价值不只是生成文字，而是在复杂任务中维持上下文、权限和结果质量。',
              },
            ],
          },
        ],
      },
    ],
  };
}

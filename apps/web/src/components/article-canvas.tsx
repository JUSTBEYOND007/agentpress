'use client';

import UniqueID from '@tiptap/extension-unique-id';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ArticleReviewExtension, articleReviewPluginKey } from './article-review-extension';
import { ArticleReviewToolbar, type ArticleReviewState } from './article-review';
import { readArticleSelection, type ArticleSelectionView } from './article-selection';
import { acknowledgeAutosave, enqueueAutosave, listPendingAutosaves } from '../lib/autosave-queue';
import { authenticatedFetch } from '../lib/authenticated-fetch';
import { EditorToolbar, slashCommands } from './editor-toolbar';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';
const AgentPressImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      assetId: { default: null },
      attribution: { default: null },
      license: { default: null },
      blockId: { default: null },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const assetId = typeof HTMLAttributes.assetId === 'string' ? HTMLAttributes.assetId : '';
    const source = typeof HTMLAttributes.src === 'string' ? HTMLAttributes.src : '';
    return [
      'img',
      {
        ...HTMLAttributes,
        src: assetId ? `${apiUrl}/media/${assetId}/content` : source,
        loading: 'lazy',
      },
    ];
  },
});

export function ArticleCanvas({
  articleId,
  baseRevisionId,
  initialDocument,
  review,
  reviewActiveIndex = 0,
  onReviewDecisionAll,
  onReviewMove,
  onReviewErrorDismiss,
  onReviewSubmit,
  onReviewVisibleChange,
  onSelectionChange,
}: {
  readonly articleId: string;
  readonly baseRevisionId: string;
  readonly initialDocument: Readonly<Record<string, unknown>>;
  readonly review?: ArticleReviewState;
  readonly reviewActiveIndex?: number;
  readonly onReviewDecisionAll?: (decision: 'accepted' | 'rejected') => void;
  readonly onReviewMove?: (offset: number) => void;
  readonly onReviewErrorDismiss?: () => void;
  readonly onReviewSubmit?: () => Promise<void>;
  readonly onReviewVisibleChange?: (visible: boolean) => void;
  readonly onSelectionChange?: (selection?: ArticleSelectionView) => void;
}): React.JSX.Element {
  const [saveState, setSaveState] = useState<'connecting' | 'saved' | 'saving' | 'offline'>(
    'connecting',
  );
  const [slashOpen, setSlashOpen] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const leaseId = useRef(leaseIdFor(articleId));
  const leaseOwned = useRef(false);
  const chain = useRef(Promise.resolve());
  const clientSequence = useRef(0);
  const revisionId = useRef(baseRevisionId);
  const commitTimer = useRef<number | undefined>(undefined);
  const isRecovering = useRef(false);
  const leaseGeneration = useRef(0);
  const reviewVisible = useRef(false);
  const selectionGeneration = useRef(0);
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: false,
      extensions: [
        StarterKit,
        TableKit.configure({ table: { resizable: true } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder: '输入 / 打开命令，或直接开始写作' }),
        AgentPressImage.configure({ allowBase64: false, inline: false }),
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
            'taskList',
            'taskItem',
            'table',
            'tableRow',
            'tableHeader',
            'tableCell',
          ],
        }),
        ArticleReviewExtension,
      ],
      content: initialDocument,
      editorProps: {
        handleKeyDown: (_view, event) => {
          if (event.key === '/' && editor?.state.selection.$from.parent.textContent.length === 0)
            setSlashOpen(true);
          if (event.key === 'Escape') setSlashOpen(false);
          return false;
        },
      },
      onSelectionUpdate: ({ editor: currentEditor }) => {
        setEditorVersion((value) => value + 1);
        void publishSelection(currentEditor, revisionId.current);
      },
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
            if (!leaseOwned.current) {
              setSaveState('offline');
              return;
            }
            const response = await sendAutosave(articleId, revisionId.current, leaseId.current, {
              updateId,
              steps,
            });
            if (!response.ok) {
              setSaveState('offline');
              return;
            }
            const acknowledgement = (await response.json()) as { readonly serverSequence: number };
            await acknowledgeAutosave(updateId);
            setSaveState('saved');
            scheduleDraftCommit(acknowledgement.serverSequence);
          })
          .catch(() => {
            setSaveState('offline');
          });
      },
    },
    [articleId],
  );

  useEffect(() => {
    if (!editor) return;
    let active = true;
    const initialize = async (): Promise<void> => {
      setSaveState('connecting');
      const leaseResponse = await writerLeaseRequest(articleId, leaseId.current, 'acquire');
      const lease = (await leaseResponse.json()) as { readonly owned?: unknown };
      if (!leaseResponse.ok || lease.owned !== true) throw new Error('Writer lease is unavailable');
      leaseOwned.current = true;

      const pending = await listPendingAutosaves(articleId);
      for (const batch of pending) {
        const response = await sendAutosave(articleId, revisionId.current, leaseId.current, batch);
        if (!response.ok) throw new Error(await response.text());
        await acknowledgeAutosave(batch.updateId);
      }

      const draftResponse = await authenticatedFetch(`${apiUrl}/articles/${articleId}/draft`);
      if (draftResponse.ok) {
        const draft = (await draftResponse.json()) as {
          readonly document?: Readonly<Record<string, unknown>>;
        };
        if (draft.document) {
          isRecovering.current = true;
          try {
            editor.commands.setContent(draft.document);
          } finally {
            isRecovering.current = false;
          }
        }
      } else if (draftResponse.status !== 404) {
        throw new Error(await draftResponse.text());
      }
      if (!active) return;
      if (!reviewVisible.current) editor.setEditable(true);
      setSaveState('saved');
    };
    void initialize().catch(() => {
      if (!active) return;
      leaseOwned.current = false;
      editor.setEditable(false);
      setSaveState('offline');
    });
    return () => {
      active = false;
      if (commitTimer.current) window.clearTimeout(commitTimer.current);
      leaseOwned.current = false;
      editor.setEditable(false);
    };
  }, [articleId, editor]);
  useEffect(() => {
    if (!editor) return;
    reviewVisible.current = Boolean(review?.visible);
    editor.view.dispatch(editor.state.tr.setMeta(articleReviewPluginKey, review ?? null));
    editor.setEditable(!review?.visible);
  }, [editor, review]);
  useEffect(() => {
    leaseGeneration.current += 1;
    const generation = leaseGeneration.current;
    const timer = window.setInterval(() => {
      if (!leaseOwned.current) return;
      void writerLeaseRequest(articleId, leaseId.current, 'renew').then(async (response) => {
        const result = (await response.json()) as { readonly owned?: unknown };
        if (result.owned !== true) {
          leaseOwned.current = false;
          editor?.setEditable(false);
          setSaveState('offline');
        }
      });
    }, 10_000);
    return () => {
      window.clearInterval(timer);
      window.setTimeout(() => {
        if (leaseGeneration.current === generation)
          void writerLeaseRequest(articleId, leaseId.current, 'release');
      });
    };
  }, [articleId, editor]);

  return (
    <section className="article-editor-shell">
      {editor ? <EditorToolbar editor={editor} key={editorVersion} /> : null}
      {editor && review?.visible ? (
        <ArticleReviewToolbar
          activeIndex={reviewActiveIndex}
          onDecisionAll={(decision) => onReviewDecisionAll?.(decision)}
          onMove={(offset) => onReviewMove?.(offset)}
          onSubmit={async () => onReviewSubmit?.()}
          onVisibleChange={(visible) => onReviewVisibleChange?.(visible)}
          review={review}
        />
      ) : null}
      {review && !review.visible && review.error ? (
        <div className="article-review-error article-review-error-standalone" role="alert">
          <RotateCcw aria-hidden="true" size={12} />
          <span>{review.error}</span>
          <button
            aria-label="关闭正文修改提示"
            onClick={() => {
              onReviewErrorDismiss?.();
            }}
            type="button"
          >
            <X aria-hidden="true" size={13} />
          </button>
        </div>
      ) : null}
      <div className={`save-state save-${saveState}`} aria-live="polite">
        {saveState === 'connecting'
          ? '正在恢复'
          : saveState === 'saved'
            ? '已保存'
            : saveState === 'saving'
              ? '保存中'
              : '本地草稿'}
      </div>
      <EditorContent className="article-canvas" editor={editor} />
      {editor && slashOpen ? (
        <div className="slash-menu" role="menu" aria-label="块命令">
          {slashCommands.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                item.run(editor);
                setSlashOpen(false);
              }}
              role="menuitem"
              type="button"
            >
              <strong>{item.label}</strong>
              <span>{item.keywords}</span>
            </button>
          ))}
        </div>
      ) : null}
      {editor ? <DocumentOutline editor={editor} version={editorVersion} /> : null}
    </section>
  );

  function scheduleDraftCommit(serverSequence: number): void {
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      chain.current = chain.current
        .then(async () => {
          if (!leaseOwned.current) return;
          const response = await authenticatedFetch(
            `${apiUrl}/articles/${articleId}/draft/commit`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                writerLeaseId: leaseId.current,
                expectedServerSequence: serverSequence,
              }),
            },
          );
          if (!response.ok) throw new Error(await response.text());
          const committed = (await response.json()) as { readonly revisionId: string };
          revisionId.current = committed.revisionId;
          if (editor) await publishSelection(editor, committed.revisionId);
          setSaveState('saved');
        })
        .catch(() => {
          setSaveState('offline');
        });
    }, 1_200);
  }

  async function publishSelection(
    currentEditor: NonNullable<ReturnType<typeof useEditor>>,
    currentRevisionId: string,
  ): Promise<void> {
    const generation = ++selectionGeneration.current;
    const selection = await readArticleSelection(currentEditor, articleId, currentRevisionId);
    if (generation === selectionGeneration.current) onSelectionChange?.(selection);
  }
}

function DocumentOutline({
  editor,
  version: _version,
}: {
  readonly editor: NonNullable<ReturnType<typeof useEditor>>;
  readonly version: number;
}): React.JSX.Element | null {
  const headings: { level: number; text: string; position: number }[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'heading')
      headings.push({
        level: Number(node.attrs.level),
        text: node.textContent || '无标题',
        position,
      });
  });
  if (headings.length < 2) return null;
  return (
    <details className="document-outline">
      <summary>目录</summary>
      <nav aria-label="文章目录">
        {headings.map((heading, index) => (
          <button
            key={`${String(heading.position)}-${String(index)}`}
            onClick={() => {
              editor
                .chain()
                .focus()
                .setTextSelection(heading.position + 1)
                .scrollIntoView()
                .run();
            }}
            style={{ paddingLeft: 8 + (heading.level - 1) * 10 }}
            type="button"
          >
            {heading.text}
          </button>
        ))}
      </nav>
    </details>
  );
}

function writerLeaseRequest(articleId: string, leaseId: string, action: string): Promise<Response> {
  return authenticatedFetch(`${apiUrl}/articles/${articleId}/writer-lease`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, leaseId }),
  });
}

function sendAutosave(
  articleId: string,
  baseRevisionId: string,
  leaseId: string,
  batch: { readonly updateId: string; readonly steps: readonly unknown[] },
): Promise<Response> {
  return authenticatedFetch(`${apiUrl}/articles/${articleId}/autosave`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      updateId: batch.updateId,
      writerLeaseId: leaseId,
      baseRevisionId,
      schemaVersion: 1,
      steps: batch.steps,
    }),
  });
}

function leaseIdFor(articleId: string): string {
  const key = `agentpress:writer-lease:${articleId}`;
  if (typeof window === 'undefined') return crypto.randomUUID();
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(key, created);
  return created;
}

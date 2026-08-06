'use client';

import UniqueID from '@tiptap/extension-unique-id';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { RefreshCw, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ArticleReviewExtension, articleReviewPluginKey } from './article-review-extension';
import type { ArticleReviewState } from './article-review';
import { ArticleReviewToolbar } from './article-review-toolbar';
import { readArticleSelection, type ArticleSelectionView } from './article-selection';
import { acknowledgeAutosave, enqueueAutosave, listPendingAutosaves } from '../lib/autosave-queue';
import { authenticatedFetch } from '../lib/authenticated-fetch';
import {
  createWriterLeaseId,
  requiresWriterLeaseForAgentSend,
  WriterLeaseCoordinator,
  type WriterLeaseState,
} from '../lib/writer-lease-coordinator';
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
  onReviewVisibleChange,
  onSelectionChange,
  onAgentSendPreparation,
  onAgentWriterStateChange,
}: {
  readonly articleId: string;
  readonly baseRevisionId: string;
  readonly initialDocument: Readonly<Record<string, unknown>>;
  readonly review?: ArticleReviewState;
  readonly reviewActiveIndex?: number;
  readonly onReviewDecisionAll?: (decision: 'accepted' | 'rejected') => void;
  readonly onReviewMove?: (offset: number) => void;
  readonly onReviewErrorDismiss?: () => void;
  readonly onReviewVisibleChange?: (visible: boolean) => void;
  readonly onSelectionChange?: (selection?: ArticleSelectionView) => void;
  readonly onAgentSendPreparation?: (prepare?: () => Promise<void>) => void;
  readonly onAgentWriterStateChange?: (connected: boolean) => void;
}): React.JSX.Element {
  const [saveState, setSaveState] = useState<'connecting' | 'saved' | 'saving' | 'offline'>(
    'connecting',
  );
  const [slashOpen, setSlashOpen] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const leaseCoordinator = useRef<WriterLeaseCoordinator | undefined>(undefined);
  const chain = useRef(Promise.resolve());
  const clientSequence = useRef(0);
  const revisionId = useRef(baseRevisionId);
  const commitTimer = useRef<number | undefined>(undefined);
  const latestServerSequence = useRef(0);
  const isRecovering = useRef(false);
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
            const lease = leaseCoordinator.current;
            if (!lease?.isOwned) {
              setSaveState('offline');
              return;
            }
            const response = await sendAutosave(articleId, revisionId.current, lease.id, {
              updateId,
              steps,
            });
            if (!response.ok) {
              lease.markLost();
              setSaveState('offline');
              return;
            }
            const acknowledgement = (await response.json()) as { readonly serverSequence: number };
            await acknowledgeAutosave(updateId);
            setSaveState('saved');
            latestServerSequence.current = acknowledgement.serverSequence;
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
    const lease = new WriterLeaseCoordinator(
      async (action, leaseId) => {
        const response = await writerLeaseRequest(articleId, leaseId, action);
        if (!response.ok) return false;
        const result = (await response.json()) as { readonly owned?: unknown };
        return result.owned === true;
      },
      createWriterLeaseId(),
      (state: WriterLeaseState) => {
        if (!active) return;
        const connected = state === 'owned';
        onAgentWriterStateChange?.(connected);
        if (state === 'connecting') setSaveState('connecting');
        if (state === 'lost') {
          editor.setEditable(false);
          setSaveState('offline');
        }
      },
    );
    leaseCoordinator.current = lease;
    const initialize = async (): Promise<void> => {
      setSaveState('connecting');
      if (!(await lease.start())) throw new Error('Writer lease is unavailable');
      await flushPendingAutosaves(lease);

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
      if (!lease.isOwned) throw new Error('Writer lease was lost during initialization');
      if (!reviewVisible.current) editor.setEditable(true);
      setSaveState('saved');
    };
    chain.current = chain.current.then(initialize).catch(() => {
      if (!active) return;
      lease.markLost();
      editor.setEditable(false);
      setSaveState('offline');
    });
    const renewTimer = window.setInterval(() => {
      void lease
        .maintain()
        .then((owned) => {
          if (!active || !owned) return;
          if (!reviewVisible.current) editor.setEditable(true);
          setSaveState((current) => (current === 'offline' ? 'saved' : current));
        })
        .catch(() => {
          lease.markLost();
        });
    }, 10_000);
    return () => {
      active = false;
      window.clearInterval(renewTimer);
      if (commitTimer.current) window.clearTimeout(commitTimer.current);
      if (leaseCoordinator.current === lease) leaseCoordinator.current = undefined;
      editor.setEditable(false);
      void lease.stop();
    };
  }, [articleId, editor, onAgentWriterStateChange]);
  useEffect(() => {
    if (!onAgentSendPreparation) return;
    const prepare = async (): Promise<void> => {
      if (commitTimer.current) window.clearTimeout(commitTimer.current);
      await chain.current;
      const pending = await listPendingAutosaves(articleId);
      if (!requiresWriterLeaseForAgentSend(pending.length, latestServerSequence.current)) return;
      const lease = leaseCoordinator.current;
      if (!lease || !(await lease.ensureOwned()))
        throw new Error('正文草稿尚未同步，连接恢复后再发送');
      try {
        setSaveState('saving');
        await flushPendingAutosaves(lease, pending);
        if (latestServerSequence.current > 0)
          await commitDraft(latestServerSequence.current, lease);
      } catch {
        lease.markLost();
        setSaveState('offline');
        throw new Error('正文草稿尚未同步，连接恢复后再发送');
      }
    };
    onAgentSendPreparation(prepare);
    return () => {
      onAgentSendPreparation(undefined);
    };
  }, [articleId, onAgentSendPreparation]);
  useEffect(() => {
    if (!editor) return;
    reviewVisible.current = Boolean(review?.visible);
    editor.view.dispatch(editor.state.tr.setMeta(articleReviewPluginKey, review ?? null));
    editor.setEditable(!review?.visible && Boolean(leaseCoordinator.current?.isOwned));
  }, [editor, review]);
  return (
    <section className="article-editor-shell">
      {editor ? <EditorToolbar editor={editor} key={editorVersion} /> : null}
      {editor && review?.visible ? (
        <ArticleReviewToolbar
          activeIndex={reviewActiveIndex}
          onDecisionAll={(decision) => onReviewDecisionAll?.(decision)}
          onMove={(offset) => onReviewMove?.(offset)}
          onVisibleChange={(visible) => onReviewVisibleChange?.(visible)}
          review={review}
        />
      ) : null}
      {review && !review.visible && review.error ? (
        <div className="article-review-error article-review-error-standalone" role="alert">
          <RotateCcw aria-hidden="true" size={12} />
          <span>{review.error}</span>
          {review.onReload ? (
            <button
              aria-label="重新加载最新正文"
              onClick={review.onReload}
              title="重新加载最新正文"
              type="button"
            >
              <RefreshCw aria-hidden="true" size={13} />
            </button>
          ) : null}
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
          const lease = leaseCoordinator.current;
          if (lease?.isOwned) await commitDraft(serverSequence, lease);
        })
        .catch(() => {
          leaseCoordinator.current?.markLost();
          setSaveState('offline');
        });
    }, 1_200);
  }

  async function commitDraft(serverSequence: number, lease: WriterLeaseCoordinator): Promise<void> {
    const response = await authenticatedFetch(`${apiUrl}/articles/${articleId}/draft/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        writerLeaseId: lease.id,
        expectedServerSequence: serverSequence,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const committed = (await response.json()) as { readonly revisionId: string };
    latestServerSequence.current = 0;
    revisionId.current = committed.revisionId;
    if (editor) await publishSelection(editor, committed.revisionId);
    setSaveState('saved');
  }

  async function flushPendingAutosaves(
    lease: WriterLeaseCoordinator,
    pending?: Awaited<ReturnType<typeof listPendingAutosaves>>,
  ): Promise<void> {
    const batches = pending ?? (await listPendingAutosaves(articleId));
    for (const batch of batches) {
      const response = await sendAutosave(articleId, revisionId.current, lease.id, batch);
      if (!response.ok) throw new Error(await response.text());
      const acknowledgement = (await response.json()) as { readonly serverSequence: number };
      await acknowledgeAutosave(batch.updateId);
      latestServerSequence.current = acknowledgement.serverSequence;
    }
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

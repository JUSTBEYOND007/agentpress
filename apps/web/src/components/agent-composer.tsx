'use client';

import {
  ComposerPrimitive,
  WebSpeechDictationAdapter,
  unstable_useMentionAdapter,
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { ArrowUp, AtSign, Paperclip, Plus, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentSendMode } from '../lib/agentpress-assistant-runtime';
import type { PendingDirective } from '../lib/agentpress-assistant-runtime';
import type { ArticleSelectionView } from './article-selection';
import {
  ComposerDictationControl,
  ComposerSendModeControl,
  ComposerTriggerMenu,
} from './agent-composer-controls';
import { ComposerContextRow, ComposerPendingDirectives } from './agent-composer-context';
import { AgentComposerDraft } from './agent-composer-draft';
import { prepareComposerFiles } from './agent-composer-files';
import { deriveAgentComposerState } from './agent-composer-state';
import type { AttachmentView, SkillView } from './agent-view-model';

type ComposerMenu = 'mode';

export function AgentComposer({
  activeArticleTitle,
  activeArticleId,
  articleSelection,
  articles,
  attachmentError,
  attachments,
  activeRun,
  branchId,
  conversationId,
  pendingReview,
  onArticleMentionChange,
  onAttachmentErrorDismiss,
  onMentionChange,
  onPendingDirectiveCancel,
  onSelectionIncludedChange,
  onAttachmentRemove,
  onAttachmentUpload,
  onSkillChange,
  readiness,
  pendingDirectives,
  selectedArticleIds,
  selectionIncluded,
  selectedSkillKeys,
  sendMode,
  setSendMode,
  skills,
  uploadingAttachments,
}: {
  readonly activeArticleTitle?: string;
  readonly activeArticleId?: string;
  readonly articleSelection?: ArticleSelectionView;
  readonly articles: readonly {
    readonly id: string;
    readonly revisionId: string;
    readonly title: string;
  }[];
  readonly attachmentError?: string;
  readonly attachments: readonly AttachmentView[];
  readonly activeRun?: {
    readonly mode: 'direct' | 'planned';
    readonly status: string;
    readonly terminal: boolean;
  };
  readonly branchId?: string;
  readonly conversationId?: string;
  readonly pendingReview: boolean;
  readonly onArticleMentionChange: (value: readonly string[]) => void;
  readonly onMentionChange: (value: boolean) => void;
  readonly onPendingDirectiveCancel: (directive: PendingDirective) => Promise<void>;
  readonly onSelectionIncludedChange: (value: boolean) => void;
  readonly onAttachmentRemove: (id: string) => void;
  readonly onAttachmentErrorDismiss: () => void;
  readonly onAttachmentUpload: (files: readonly File[]) => Promise<void>;
  readonly onSkillChange: (value: readonly string[]) => void;
  readonly readiness: 'checking' | 'ready' | 'unavailable';
  readonly pendingDirectives: readonly PendingDirective[];
  readonly selectedArticleIds: readonly string[];
  readonly selectionIncluded: boolean;
  readonly selectedSkillKeys: readonly string[];
  readonly sendMode: AgentSendMode;
  readonly setSendMode: (mode: AgentSendMode) => void;
  readonly skills: readonly SkillView[];
  readonly uploadingAttachments: number;
}): React.JSX.Element {
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const composerText = useAuiState((state) => state.composer.text);
  const aui = useAui();
  const [openMenu, setOpenMenu] = useState<ComposerMenu>();
  const [dropActive, setDropActive] = useState(false);
  const [fileNotice, setFileNotice] = useState<string>();
  const [dictationSupported, setDictationSupported] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLFormElement>(null);
  const running = Boolean(activeRun && !activeRun.terminal);

  useEffect(() => {
    setDictationSupported(WebSpeechDictationAdapter.isSupported());
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpenMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenMenu(undefined);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [openMenu]);

  const addFiles = useCallback(
    async (input: readonly File[]): Promise<void> => {
      if (running) {
        setFileNotice('当前任务进行中，附件可在下一次新任务开始前添加。');
        return;
      }
      const prepared = prepareComposerFiles(input, 10 - attachments.length);
      setFileNotice(prepared.message);
      if (prepared.files.length > 0) await onAttachmentUpload(prepared.files);
    },
    [attachments.length, onAttachmentUpload, running],
  );
  // assistant-ui 0.15 exposes mention/slash triggers through this unstable adapter API.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const mention = unstable_useMentionAdapter({
    categories: [
      {
        id: 'current',
        label: '当前内容',
        items: [
          ...(activeArticleId && activeArticleTitle
            ? [
                {
                  id: `article:${activeArticleId}`,
                  type: 'article',
                  label: activeArticleTitle,
                  description: '当前文章',
                  icon: 'article',
                },
              ]
            : []),
          ...(articleSelection
            ? [
                {
                  id: `selection:${articleSelection.articleId}`,
                  type: 'selection',
                  label: `选中 ${String(articleSelection.blocks.length)} 个段落`,
                  description: articleSelection.preview || '当前正文选区',
                  icon: 'selection',
                },
              ]
            : []),
        ],
      },
      {
        id: 'articles',
        label: '工作区文章',
        items: articles
          .filter(({ id }) => id !== activeArticleId)
          .map((article) => ({
            id: `article:${article.id}`,
            type: 'article',
            label: article.title,
            description: selectedArticleIds.includes(article.id) ? '已加入上下文' : '文章',
            icon: 'article',
          })),
      },
    ],
    includeModelContextTools: false,
  });
  // assistant-ui 0.15 exposes slash command triggers through this unstable adapter API.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const slash = unstable_useSlashCommandAdapter({
    commands: skills.map((skill) => ({
      id: skill.skillId,
      label: `/${skill.skillId}`,
      description: skillCommandDescription(
        skill,
        selectedSkillKeys.includes(`${skill.skillId}@${skill.version}`),
      ),
      icon: 'skill',
      execute: () => {
        const key = `${skill.skillId}@${skill.version}`;
        if (skill.status !== 'load_failed' && !selectedSkillKeys.includes(key))
          onSkillChange([...selectedSkillKeys, key]);
      },
    })),
    removeOnExecute: true,
  });
  const notice = attachmentError ?? fileNotice;
  const lifecycle = deriveAgentComposerState({
    readiness,
    hasConversation: Boolean(conversationId && branchId),
    uploadingAttachments,
    ...(activeRun ? { activeRun } : {}),
    sendMode,
  });

  const insertTrigger = (trigger: '@' | '/'): void => {
    const separator = composerText.length > 0 && !composerText.endsWith(' ') ? ' ' : '';
    aui.composer.setText(`${composerText}${separator}${trigger}`);
  };

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <div className="composer-shell">
        <ComposerPrimitive.Unstable_TriggerPopover
          adapter={running ? undefined : mention.adapter}
          aria-label="添加上下文"
          char="@"
          className="composer-trigger-menu"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Action
            onExecute={(item) => {
              if (item.id.startsWith('selection:')) {
                onSelectionIncludedChange(true);
                return;
              }
              const articleId = item.id.startsWith('article:') ? item.id.slice(8) : '';
              if (!articleId) return;
              if (articleId === activeArticleId) onMentionChange(true);
              else if (!selectedArticleIds.includes(articleId))
                onArticleMentionChange([...selectedArticleIds, articleId]);
            }}
            removeOnExecute
          />
          <ComposerTriggerMenu heading="添加上下文" />
        </ComposerPrimitive.Unstable_TriggerPopover>
        <ComposerPrimitive.Unstable_TriggerPopover
          adapter={running ? undefined : slash.adapter}
          aria-label="使用写作技能"
          char="/"
          className="composer-trigger-menu"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
          <ComposerTriggerMenu heading="写作技能" />
        </ComposerPrimitive.Unstable_TriggerPopover>
        <ComposerPrimitive.Root
          className={dropActive ? 'agent-composer is-drop-active' : 'agent-composer'}
          onSubmit={(event) => {
            event.preventDefault();
            if (lifecycle.sendDisabledReason) return;
            aui.composer.send({ steer: lifecycle.submissionKind === 'steering' });
          }}
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes('Files')) setDropActive(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDropActive(false);
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDrop={(event) => {
            setDropActive(false);
            if (event.dataTransfer.files.length === 0) return;
            event.preventDefault();
            void addFiles([...event.dataTransfer.files]);
          }}
          ref={root}
        >
          <AgentComposerDraft
            {...(conversationId && branchId ? { threadKey: `${conversationId}:${branchId}` } : {})}
          />
          <ComposerPendingDirectives
            directives={pendingDirectives}
            onCancel={onPendingDirectiveCancel}
            onError={setFileNotice}
          />
          <ComposerContextRow
            {...(activeArticleTitle ? { activeArticleTitle } : {})}
            {...(articleSelection ? { articleSelection } : {})}
            articles={articles}
            attachments={attachments}
            {...(running && lifecycle.contextLabel ? { contextLabel: lifecycle.contextLabel } : {})}
            onArticleMentionChange={onArticleMentionChange}
            onAttachmentRemove={onAttachmentRemove}
            onSelectionIncludedChange={onSelectionIncludedChange}
            onSkillChange={onSkillChange}
            pendingReview={pendingReview}
            selectedArticleIds={selectedArticleIds}
            selectedSkillKeys={selectedSkillKeys}
            selectionIncluded={selectionIncluded}
            uploadingAttachments={uploadingAttachments}
          />
          <input
            accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
            hidden
            multiple
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              if (files.length > 0) void addFiles(files);
              event.currentTarget.value = '';
            }}
            ref={fileInput}
            type="file"
          />
          <ComposerPrimitive.Input
            addAttachmentOnPaste={false}
            aria-label="发送消息给写作助手"
            maxRows={9}
            minRows={2}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length === 0) return;
              event.preventDefault();
              void addFiles(files);
            }}
            placeholder={lifecycle.placeholder}
            submitMode="enter"
            unstable_insertNewlineOnTouchEnter
          />
          {dropActive ? (
            <div className="composer-drop-overlay" role="status">
              <Paperclip aria-hidden="true" size={18} />
              松开即可添加资料
            </div>
          ) : null}
          {notice ? (
            <div className="composer-inline-notice" role="alert">
              <span>{notice}</span>
              <button
                aria-label="关闭提示"
                onClick={() => {
                  setFileNotice(undefined);
                  onAttachmentErrorDismiss();
                }}
                type="button"
              >
                <X size={12} />
              </button>
            </div>
          ) : null}
          <div className="composer-actions">
            <div className="composer-menu-wrap">
              <button
                aria-label="添加附件"
                className="composer-tool-button"
                disabled={running || uploadingAttachments > 0 || attachments.length >= 10}
                onClick={() => {
                  fileInput.current?.click();
                }}
                title="添加附件"
                type="button"
              >
                <Plus size={16} />
              </button>
              <button
                aria-label="添加上下文"
                className="composer-tool-button"
                disabled={running}
                onClick={() => {
                  insertTrigger('@');
                }}
                title="添加上下文"
                type="button"
              >
                <AtSign size={15} />
              </button>
              <button
                aria-label="使用写作技能"
                className="composer-tool-button composer-slash-button"
                disabled={running}
                onClick={() => {
                  insertTrigger('/');
                }}
                title="使用写作技能"
                type="button"
              >
                /
              </button>
              {dictationSupported ? <ComposerDictationControl /> : null}
              {running ? (
                <ComposerSendModeControl
                  open={openMenu === 'mode'}
                  onOpenChange={() => {
                    setOpenMenu((value) => (value === 'mode' ? undefined : 'mode'));
                  }}
                  onSelect={(mode) => {
                    setSendMode(mode);
                    setOpenMenu(undefined);
                  }}
                  value={sendMode}
                />
              ) : null}
            </div>
            <div className="composer-primary-actions">
              {threadRunning && lifecycle.termination ? (
                <ComposerPrimitive.Cancel asChild>
                  <button
                    aria-label={lifecycle.termination.label}
                    className="run-termination-button"
                    disabled={lifecycle.termination.disabled}
                    title={lifecycle.termination.label}
                    type="button"
                  >
                    <Square size={13} />
                  </button>
                </ComposerPrimitive.Cancel>
              ) : null}
              <button
                aria-label={lifecycle.submissionLabel}
                className="send-button"
                disabled={Boolean(lifecycle.sendDisabledReason) || composerText.trim().length === 0}
                title={lifecycle.sendDisabledReason ?? `${lifecycle.submissionLabel}（Enter）`}
                type="submit"
              >
                <ArrowUp size={17} />
              </button>
            </div>
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

export function skillCommandDescription(skill: SkillView, selected: boolean): string {
  if (skill.status === 'load_failed') return '加载失败，无法绑定';
  if (selected) return '已启用';
  if (skill.status === 'policy_disabled') return `仅用户显式选择 · ${skill.description}`;
  return skill.description;
}

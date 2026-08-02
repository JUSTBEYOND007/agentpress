'use client';

import {
  AuiIf,
  ComposerPrimitive,
  WebSpeechDictationAdapter,
  unstable_useMentionAdapter,
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import {
  ArrowUp,
  AtSign,
  AudioLines,
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  LoaderCircle,
  Mic,
  Paperclip,
  Plus,
  ListChecks,
  Square,
  WandSparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentSendMode } from '../lib/agentpress-assistant-runtime';
import type { PendingDirective } from '../lib/agentpress-assistant-runtime';
import type { ArticleSelectionView } from './article-selection';
import { prepareComposerFiles } from './agent-composer-files';
import type { AttachmentView, SkillView } from './agent-view-model';

type ComposerMenu = 'mode';

export function AgentComposer({
  activeArticleTitle,
  activeArticleId,
  articleSelection,
  articles,
  attachmentError,
  attachments,
  conversationId,
  mentionActiveArticle,
  onArticleMentionChange,
  onAttachmentErrorDismiss,
  onMentionChange,
  onPendingDirectiveCancel,
  onSelectionIncludedChange,
  onAttachmentRemove,
  onAttachmentUpload,
  onSkillChange,
  readiness,
  running,
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
  readonly articles: readonly { readonly id: string; readonly revisionId: string; readonly title: string }[];
  readonly attachmentError?: string;
  readonly attachments: readonly AttachmentView[];
  readonly conversationId?: string;
  readonly mentionActiveArticle: boolean;
  readonly onArticleMentionChange: (value: readonly string[]) => void;
  readonly onMentionChange: (value: boolean) => void;
  readonly onPendingDirectiveCancel: (directive: PendingDirective) => Promise<void>;
  readonly onSelectionIncludedChange: (value: boolean) => void;
  readonly onAttachmentRemove: (id: string) => void;
  readonly onAttachmentErrorDismiss: () => void;
  readonly onAttachmentUpload: (files: readonly File[]) => Promise<void>;
  readonly onSkillChange: (value: readonly string[]) => void;
  readonly readiness: 'checking' | 'ready' | 'unavailable';
  readonly running: boolean;
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
  const [cancellingDirectiveId, setCancellingDirectiveId] = useState<string>();
  const [dictationSupported, setDictationSupported] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLFormElement>(null);

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
      description: selectedSkillKeys.includes(`${skill.skillId}@${skill.version}`)
        ? '已启用'
        : skill.description,
      icon: 'skill',
      execute: () => {
        const key = `${skill.skillId}@${skill.version}`;
        if (!selectedSkillKeys.includes(key)) onSkillChange([...selectedSkillKeys, key]);
      },
    })),
    removeOnExecute: true,
  });
  const notice = attachmentError ?? fileNotice;

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
          <TriggerMenu heading="添加上下文" />
        </ComposerPrimitive.Unstable_TriggerPopover>
        <ComposerPrimitive.Unstable_TriggerPopover
          adapter={running ? undefined : slash.adapter}
          aria-label="使用写作技能"
          char="/"
          className="composer-trigger-menu"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
          <TriggerMenu heading="写作技能" />
        </ComposerPrimitive.Unstable_TriggerPopover>
        <ComposerPrimitive.Root
          className={dropActive ? 'agent-composer is-drop-active' : 'agent-composer'}
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
          <ComposerDraft {...(conversationId ? { conversationId } : {})} />
          {pendingDirectives.length > 0 ? (
            <div className="composer-pending" aria-label="待处理的补充要求">
              {pendingDirectives.map((directive) => (
                <span className={`pending-directive pending-${directive.kind}`} key={directive.id}>
                  <ListChecks aria-hidden="true" size={12} />
                  <span>
                    <small>{directive.kind === 'steering' ? '待应用' : '完成后继续'}</small>
                    {directive.content}
                  </span>
                  <button
                    aria-label="撤销这条补充要求"
                    disabled={cancellingDirectiveId === directive.id}
                    onClick={() => {
                      setCancellingDirectiveId(directive.id);
                      void onPendingDirectiveCancel(directive)
                        .catch(() => {
                          setFileNotice('这条补充要求未能撤销，请稍后重试。');
                        })
                        .finally(() => {
                          setCancellingDirectiveId(undefined);
                        });
                    }}
                    type="button"
                  >
                    {cancellingDirectiveId === directive.id ? (
                      <LoaderCircle className="is-spinning" size={11} />
                    ) : (
                      <X size={11} />
                    )}
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="composer-context" aria-label="本次对话上下文">
            {activeArticleTitle && mentionActiveArticle ? (
              <ContextChip
                icon={<FileText aria-hidden="true" size={12} />}
                label={activeArticleTitle}
                onRemove={() => {
                  onMentionChange(false);
                }}
                removeLabel="移除当前文章"
              />
            ) : null}
            {articleSelection && selectionIncluded ? (
              <ContextChip
                icon={<ListChecks aria-hidden="true" size={12} />}
                label={`选中 ${String(articleSelection.blocks.length)} 个段落`}
                onRemove={() => {
                  onSelectionIncludedChange(false);
                }}
                removeLabel="移除正文选区"
              />
            ) : null}
            {selectedArticleIds.map((id) => {
              const article = articles.find((candidate) => candidate.id === id);
              return article ? (
                <ContextChip
                  icon={<FileText aria-hidden="true" size={12} />}
                  key={id}
                  label={article.title}
                  onRemove={() => {
                    onArticleMentionChange(selectedArticleIds.filter((item) => item !== id));
                  }}
                  removeLabel={`移除 ${article.title}`}
                />
              ) : null;
            })}
            {selectedSkillKeys.map((key) => (
              <ContextChip
                icon={<WandSparkles aria-hidden="true" size={12} />}
                key={key}
                label={`/${key.split('@')[0] ?? key}`}
                onRemove={() => {
                  onSkillChange(selectedSkillKeys.filter((item) => item !== key));
                }}
                removeLabel="移除技能"
              />
            ))}
            {attachments.map((attachment) => (
              <ContextChip
                icon={<Paperclip aria-hidden="true" size={12} />}
                key={attachment.id}
                label={attachment.filename}
                onRemove={() => {
                  onAttachmentRemove(attachment.id);
                }}
                removeLabel={`移除 ${attachment.filename}`}
              />
            ))}
            {uploadingAttachments > 0 ? (
              <span className="composer-upload-chip" role="status">
                <LoaderCircle aria-hidden="true" className="is-spinning" size={12} />
                正在解析 {uploadingAttachments} 个附件
              </span>
            ) : null}
          </div>
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
            placeholder={composerPlaceholder(readiness, running, sendMode)}
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
              {dictationSupported ? <DictationControl /> : null}
              {running ? (
                <SendModeControl
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
            {threadRunning ? (
              <ComposerPrimitive.Cancel asChild>
                <button aria-label="停止生成" className="send-button" title="停止" type="button">
                  <Square size={13} />
                </button>
              </ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send asChild>
                <button
                  aria-label="发送消息"
                  className="send-button"
                  title="发送（Enter）"
                  type="submit"
                >
                  <ArrowUp size={17} />
                </button>
              </ComposerPrimitive.Send>
            )}
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

function ComposerDraft({ conversationId }: { readonly conversationId?: string }): null {
  const aui = useAui();
  const value = useAuiState((state) => state.composer.text);
  const activeKey = useRef<string | null>(null);
  const skippedValue = useRef<string | null>(null);
  const currentValue = useRef(value);
  currentValue.current = value;
  useEffect(() => {
    const key = conversationId ? `agentpress:composer-draft:${conversationId}` : null;
    activeKey.current = key;
    skippedValue.current = currentValue.current;
    try {
      aui.composer.setText(key ? (window.localStorage.getItem(key) ?? '') : '');
    } catch {
      aui.composer.setText('');
    }
  }, [aui, conversationId]);
  useEffect(() => {
    if (skippedValue.current === value) {
      skippedValue.current = null;
      return;
    }
    const key = activeKey.current;
    if (!key) return;
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch {
      // Draft persistence is best-effort when browser storage is unavailable.
    }
  }, [value]);
  return null;
}

function ContextChip({
  icon,
  label,
  onRemove,
  removeLabel,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onRemove: () => void;
  readonly removeLabel: string;
}): React.JSX.Element {
  return (
    <span className="composer-context-chip">
      {icon}
      <span>{label}</span>
      <button aria-label={removeLabel} onClick={onRemove} title={removeLabel} type="button">
        <X aria-hidden="true" size={11} />
      </button>
    </span>
  );
}

function TriggerMenu({ heading }: { readonly heading: string }): React.JSX.Element {
  return (
    <div className="composer-trigger-content">
      <div className="composer-trigger-heading">
        <ComposerPrimitive.Unstable_TriggerPopoverBack
          aria-label="返回分类"
          className="composer-trigger-back"
        >
          <ChevronLeft aria-hidden="true" size={14} />
        </ComposerPrimitive.Unstable_TriggerPopoverBack>
        <span>{heading}</span>
      </div>
      <ComposerPrimitive.Unstable_TriggerPopoverCategories className="composer-trigger-list">
        {(categories) =>
          categories.map((category) => (
            <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
              categoryId={category.id}
              className="composer-trigger-item"
              key={category.id}
            >
              {category.id === 'current' ? (
                <ListChecks aria-hidden="true" size={14} />
              ) : (
                <FileText aria-hidden="true" size={14} />
              )}
              <span>
                <strong>{category.label}</strong>
              </span>
              <ChevronRight aria-hidden="true" size={13} />
            </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverCategories>
      <ComposerPrimitive.Unstable_TriggerPopoverItems className="composer-trigger-list">
        {(items) =>
          items.map((item, index) => (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              className="composer-trigger-item"
              index={index}
              item={item}
              key={`${item.type}:${item.id}`}
            >
              {item.type === 'selection' ? (
                <ListChecks aria-hidden="true" size={14} />
              ) : item.type === 'article' ? (
                <FileText aria-hidden="true" size={14} />
              ) : (
                <WandSparkles aria-hidden="true" size={14} />
              )}
              <span>
                <strong>{item.label}</strong>
                {item.description ? <small>{item.description}</small> : null}
              </span>
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </div>
  );
}

function DictationControl(): React.JSX.Element {
  return (
    <>
      <AuiIf condition={(state) => !state.composer.dictation}>
        <ComposerPrimitive.Dictate asChild>
          <button
            aria-label="语音输入"
            className="composer-tool-button"
            title="语音输入"
            type="button"
          >
            <Mic size={15} />
          </button>
        </ComposerPrimitive.Dictate>
      </AuiIf>
      <AuiIf condition={(state) => Boolean(state.composer.dictation)}>
        <ComposerPrimitive.StopDictation asChild>
          <button
            aria-label="停止语音输入"
            className="composer-tool-button is-listening"
            title="停止语音输入"
            type="button"
          >
            <AudioLines size={15} />
          </button>
        </ComposerPrimitive.StopDictation>
      </AuiIf>
    </>
  );
}

function SendModeControl({
  onOpenChange,
  onSelect,
  open,
  value,
}: {
  readonly onOpenChange: () => void;
  readonly onSelect: (mode: AgentSendMode) => void;
  readonly open: boolean;
  readonly value: AgentSendMode;
}): React.JSX.Element {
  return (
    <div className="send-mode-wrap">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="send-behavior"
        onClick={onOpenChange}
        type="button"
      >
        {value === 'steering' ? '调整当前任务' : '完成后继续'}
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div aria-label="发送方式" className="send-mode-menu" role="menu">
          <ModeOption
            active={value === 'steering'}
            description="立即让助手按新要求调整"
            label="调整当前任务"
            onSelect={() => {
              onSelect('steering');
            }}
          />
          <ModeOption
            active={value === 'follow-up'}
            description="当前工作完成后再处理"
            label="完成后继续"
            onSelect={() => {
              onSelect('follow-up');
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function ModeOption({
  active,
  description,
  label,
  onSelect,
}: {
  readonly active: boolean;
  readonly description: string;
  readonly label: string;
  readonly onSelect: () => void;
}): React.JSX.Element {
  return (
    <button aria-checked={active} onClick={onSelect} role="menuitemradio" type="button">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      {active ? <Check size={14} /> : null}
    </button>
  );
}

function composerPlaceholder(
  readiness: 'checking' | 'ready' | 'unavailable',
  running: boolean,
  mode: AgentSendMode,
): string {
  if (readiness === 'checking') return '正在连接写作助手…';
  if (readiness === 'unavailable') return '写作助手暂时不可用';
  if (running && mode === 'steering') return '补充要求，助手会调整当前任务…';
  if (running) return '输入下一项任务，当前工作完成后开始…';
  return '告诉我你想写什么，或希望怎样修改正文…';
}

'use client';

import {
  AuiIf,
  ComposerPrimitive,
  WebSpeechDictationAdapter,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import {
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  FileText,
  LoaderCircle,
  Mic,
  Paperclip,
  Plus,
  Search,
  Square,
  WandSparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentSendMode } from '../lib/agentpress-assistant-runtime';
import { prepareComposerFiles } from './agent-composer-files';
import type { AttachmentView, SkillView } from './agent-view-model';

type ComposerMenu = 'context' | 'mode';

export function AgentComposer({
  activeArticleTitle,
  attachmentError,
  attachments,
  conversationId,
  mentionActiveArticle,
  onAttachmentErrorDismiss,
  onMentionChange,
  onAttachmentRemove,
  onAttachmentUpload,
  onSkillChange,
  readiness,
  running,
  selectedSkillKeys,
  sendMode,
  setSendMode,
  skills,
  uploadingAttachments,
}: {
  readonly activeArticleTitle?: string;
  readonly attachmentError?: string;
  readonly attachments: readonly AttachmentView[];
  readonly conversationId?: string;
  readonly mentionActiveArticle: boolean;
  readonly onMentionChange: (value: boolean) => void;
  readonly onAttachmentRemove: (id: string) => void;
  readonly onAttachmentErrorDismiss: () => void;
  readonly onAttachmentUpload: (files: readonly File[]) => Promise<void>;
  readonly onSkillChange: (value: readonly string[]) => void;
  readonly readiness: 'checking' | 'ready' | 'unavailable';
  readonly running: boolean;
  readonly selectedSkillKeys: readonly string[];
  readonly sendMode: AgentSendMode;
  readonly setSendMode: (mode: AgentSendMode) => void;
  readonly skills: readonly SkillView[];
  readonly uploadingAttachments: number;
}): React.JSX.Element {
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const [openMenu, setOpenMenu] = useState<ComposerMenu>();
  const [skillQuery, setSkillQuery] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const [fileNotice, setFileNotice] = useState<string>();
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
  const filteredSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase();
    if (!query) return skills;
    return skills.filter(
      (skill) =>
        skill.skillId.toLocaleLowerCase().includes(query) ||
        skill.description.toLocaleLowerCase().includes(query),
    );
  }, [skillQuery, skills]);
  const notice = attachmentError ?? fileNotice;

  return (
    <ComposerPrimitive.Root
      className={dropActive ? 'agent-composer is-drop-active' : 'agent-composer'}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
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
        {selectedSkillKeys.map((key) => (
          <ContextChip
            icon={<WandSparkles aria-hidden="true" size={12} />}
            key={key}
            label={key.split('@')[0] ?? key}
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
            aria-expanded={openMenu === 'context'}
            aria-haspopup="menu"
            aria-label="添加资料或技能"
            className="composer-tool-button"
            disabled={running}
            onClick={() => {
              setOpenMenu((value) => (value === 'context' ? undefined : 'context'));
            }}
            title={running ? '当前任务进行中' : '添加资料或技能'}
            type="button"
          >
            <Plus size={16} />
          </button>
          {openMenu === 'context' ? (
            <ContextMenu
              {...(activeArticleTitle ? { activeArticleTitle } : {})}
              attachmentsFull={attachments.length >= 10}
              filteredSkills={filteredSkills}
              mentionActiveArticle={mentionActiveArticle}
              onArticleToggle={() => {
                onMentionChange(!mentionActiveArticle);
              }}
              onFileSelect={() => {
                fileInput.current?.click();
                setOpenMenu(undefined);
              }}
              onSkillChange={onSkillChange}
              query={skillQuery}
              selectedSkillKeys={selectedSkillKeys}
              setQuery={setSkillQuery}
              uploading={uploadingAttachments > 0}
            />
          ) : null}
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

function ContextMenu({
  activeArticleTitle,
  attachmentsFull,
  filteredSkills,
  mentionActiveArticle,
  onArticleToggle,
  onFileSelect,
  onSkillChange,
  query,
  selectedSkillKeys,
  setQuery,
  uploading,
}: {
  readonly activeArticleTitle?: string;
  readonly attachmentsFull: boolean;
  readonly filteredSkills: readonly SkillView[];
  readonly mentionActiveArticle: boolean;
  readonly onArticleToggle: () => void;
  readonly onFileSelect: () => void;
  readonly onSkillChange: (value: readonly string[]) => void;
  readonly query: string;
  readonly selectedSkillKeys: readonly string[];
  readonly setQuery: (value: string) => void;
  readonly uploading: boolean;
}): React.JSX.Element {
  return (
    <div aria-label="添加资料或技能" className="composer-menu" role="menu">
      <span className="composer-menu-label">资料</span>
      {activeArticleTitle ? (
        <button onClick={onArticleToggle} role="menuitemcheckbox" type="button">
          <FileText size={14} />
          <span>
            当前文章
            <small>{activeArticleTitle}</small>
          </span>
          {mentionActiveArticle ? <Check className="menu-check" size={14} /> : null}
        </button>
      ) : null}
      <button
        disabled={uploading || attachmentsFull}
        onClick={onFileSelect}
        role="menuitem"
        type="button"
      >
        {uploading ? <LoaderCircle className="is-spinning" size={14} /> : <Paperclip size={14} />}
        <span>
          {attachmentsFull ? '附件已达上限' : uploading ? '正在解析附件' : '上传附件'}
          <small>PDF、Word、Markdown 或文本，可多选</small>
        </span>
      </button>
      {filteredSkills.length > 0 || query ? (
        <>
          <span className="composer-menu-label">写作技能</span>
          <label className="composer-menu-search">
            <Search aria-hidden="true" size={13} />
            <input
              aria-label="搜索写作技能"
              autoFocus
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="搜索技能"
              value={query}
            />
          </label>
        </>
      ) : null}
      {filteredSkills.map((skill) => {
        const key = `${skill.skillId}@${skill.version}`;
        const selected = selectedSkillKeys.includes(key);
        return (
          <button
            aria-checked={selected}
            key={key}
            onClick={() => {
              onSkillChange(
                selected
                  ? selectedSkillKeys.filter((item) => item !== key)
                  : [...selectedSkillKeys, key],
              );
            }}
            role="menuitemcheckbox"
            type="button"
          >
            <WandSparkles size={14} />
            <span>
              {skill.skillId}
              <small>{skill.description}</small>
            </span>
            {selected ? <Check className="menu-check" size={14} /> : null}
          </button>
        );
      })}
      {query && filteredSkills.length === 0 ? (
        <p className="composer-menu-empty">没有匹配的技能</p>
      ) : null}
    </div>
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

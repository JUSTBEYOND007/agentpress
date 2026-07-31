'use client';

import { ComposerPrimitive, useAuiState } from '@assistant-ui/react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  Paperclip,
  Plus,
  Square,
  WandSparkles,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';

import type { AgentSendMode } from '../lib/agentpress-assistant-runtime';
import type { AttachmentView, SkillView } from './agent-view-model';

export function AgentComposer({
  activeArticleTitle,
  attachments,
  mentionActiveArticle,
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
  uploadingAttachment,
}: {
  readonly activeArticleTitle?: string;
  readonly attachments: readonly AttachmentView[];
  readonly mentionActiveArticle: boolean;
  readonly onMentionChange: (value: boolean) => void;
  readonly onAttachmentRemove: (id: string) => void;
  readonly onAttachmentUpload: (file: File) => Promise<void>;
  readonly onSkillChange: (value: readonly string[]) => void;
  readonly readiness: 'checking' | 'ready' | 'unavailable';
  readonly running: boolean;
  readonly selectedSkillKeys: readonly string[];
  readonly sendMode: AgentSendMode;
  readonly setSendMode: (mode: AgentSendMode) => void;
  readonly skills: readonly SkillView[];
  readonly uploadingAttachment: boolean;
}): React.JSX.Element {
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const [openMenu, setOpenMenu] = useState<'context' | 'mode'>();
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <ComposerPrimitive.Root className="agent-composer">
      <div className="composer-context" aria-label="本次对话上下文">
        {activeArticleTitle ? (
          <button
            aria-pressed={mentionActiveArticle}
            className={mentionActiveArticle ? 'is-selected' : ''}
            onClick={() => {
              onMentionChange(!mentionActiveArticle);
            }}
            title={mentionActiveArticle ? '移除当前文章' : '添加当前文章'}
            type="button"
          >
            <FileText aria-hidden="true" size={11} />
            <span>{activeArticleTitle}</span>
            {mentionActiveArticle ? <X aria-hidden="true" size={10} /> : null}
          </button>
        ) : null}
        {selectedSkillKeys.map((key) => (
          <button
            key={key}
            onClick={() => {
              onSkillChange(selectedSkillKeys.filter((item) => item !== key));
            }}
            title="移除技能"
            type="button"
          >
            <WandSparkles aria-hidden="true" size={11} />
            <span>{key.split('@')[0]}</span>
            <X aria-hidden="true" size={10} />
          </button>
        ))}
        {attachments.map((attachment) => (
          <button
            key={attachment.id}
            onClick={() => {
              onAttachmentRemove(attachment.id);
            }}
            title="移除附件"
            type="button"
          >
            <Paperclip aria-hidden="true" size={11} />
            <span>{attachment.filename}</span>
            <X aria-hidden="true" size={10} />
          </button>
        ))}
      </div>
      <input
        accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onAttachmentUpload(file);
          event.currentTarget.value = '';
        }}
        ref={fileInput}
        type="file"
      />
      <ComposerPrimitive.Input
        aria-label="发送消息给写作助手"
        placeholder={
          readiness === 'ready'
            ? '告诉我你想写什么，或希望怎样修改正文…'
            : readiness === 'checking'
              ? '正在连接写作助手…'
              : '写作助手暂时不可用'
        }
        rows={2}
      />
      <div className="composer-actions">
        <div className="composer-menu-wrap">
          <button
            aria-expanded={openMenu === 'context'}
            aria-label="添加上下文"
            className="composer-tool-button"
            onClick={() => {
              setOpenMenu((value) => (value === 'context' ? undefined : 'context'));
            }}
            title="添加上下文"
            type="button"
          >
            <Plus size={15} />
          </button>
          {openMenu === 'context' ? (
            <div className="composer-menu">
              <span className="composer-menu-label">文件</span>
              <button
                disabled={uploadingAttachment}
                onClick={() => {
                  fileInput.current?.click();
                  setOpenMenu(undefined);
                }}
                type="button"
              >
                <Paperclip size={13} />
                <span>
                  {uploadingAttachment ? '正在解析附件…' : '上传附件'}
                  <small>PDF、Word、Markdown 或文本</small>
                </span>
              </button>
              {skills.length > 0 ? <span className="composer-menu-label">写作技能</span> : null}
              {skills.map((skill) => {
                const key = `${skill.skillId}@${skill.version}`;
                const selected = selectedSkillKeys.includes(key);
                return (
                  <button
                    key={key}
                    onClick={() => {
                      onSkillChange(
                        selected
                          ? selectedSkillKeys.filter((item) => item !== key)
                          : [...selectedSkillKeys, key],
                      );
                    }}
                    type="button"
                  >
                    <WandSparkles size={13} />
                    <span>
                      {skill.skillId}
                      <small>{skill.description}</small>
                    </span>
                    {selected ? <Check className="menu-check" size={13} /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {running ? (
            <div className="send-mode-wrap">
              <button
                aria-expanded={openMenu === 'mode'}
                className="send-behavior"
                onClick={() => {
                  setOpenMenu((value) => (value === 'mode' ? undefined : 'mode'));
                }}
                type="button"
              >
                {sendMode === 'steering' ? '调整当前任务' : '完成后继续'}
                <ChevronDown size={11} />
              </button>
              {openMenu === 'mode' ? (
                <div className="send-mode-menu">
                  <ModeOption
                    active={sendMode === 'steering'}
                    description="立即让助手按新要求调整"
                    label="调整当前任务"
                    onSelect={() => {
                      setSendMode('steering');
                      setOpenMenu(undefined);
                    }}
                  />
                  <ModeOption
                    active={sendMode === 'follow-up'}
                    description="当前工作完成后再处理"
                    label="完成后继续"
                    onSelect={() => {
                      setSendMode('follow-up');
                      setOpenMenu(undefined);
                    }}
                  />
                </div>
              ) : null}
            </div>
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
            <button aria-label="发送消息" className="send-button" title="发送" type="submit">
              <ArrowUp size={17} />
            </button>
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
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
    <button className={active ? 'is-selected' : ''} onClick={onSelect} type="button">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      {active ? <Check size={13} /> : null}
    </button>
  );
}

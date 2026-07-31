'use client';

import { ComposerPrimitive, useAuiState } from '@assistant-ui/react';
import { ArrowUp, ChevronDown, Paperclip, Plus, Square, X } from 'lucide-react';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <ComposerPrimitive.Root className="agent-composer">
      <div className="composer-context">
        {activeArticleTitle ? (
          <button
            className={mentionActiveArticle ? 'is-selected' : ''}
            onClick={() => { onMentionChange(!mentionActiveArticle); }}
            type="button"
          >
            @ {activeArticleTitle}
          </button>
        ) : null}
        {selectedSkillKeys.map((key) => (
          <button
            key={key}
            onClick={() => { onSkillChange(selectedSkillKeys.filter((item) => item !== key)); }}
            type="button"
          >
            / {key.split('@')[0]} <X size={10} />
          </button>
        ))}
        {attachments.map((attachment) => (
          <button
            key={attachment.id}
            onClick={() => { onAttachmentRemove(attachment.id); }}
            type="button"
          >
            <Paperclip size={10} /> {attachment.filename} <X size={10} />
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
        aria-label="发送消息给 Agent"
        placeholder={
          readiness === 'ready'
            ? '提问或描述你希望完成的工作…'
            : readiness === 'checking'
              ? '正在连接…'
              : 'Agent 尚未配置'
        }
        rows={2}
      />
      <div className="composer-actions">
        <div className="composer-menu-wrap">
          <button
            aria-expanded={menuOpen}
            aria-label="添加上下文"
            className="composer-tool-button"
            onClick={() => { setMenuOpen((value) => !value); }}
            type="button"
          >
            <Plus size={15} />
          </button>
          {menuOpen ? (
            <div className="composer-menu">
              <strong>Skills</strong>
              {skills.map((skill) => {
                const key = `${skill.skillId}@${skill.version}`;
                return (
                  <button
                    key={key}
                    onClick={() => {
                      if (!selectedSkillKeys.includes(key))
                        onSkillChange([...selectedSkillKeys, key]);
                      setMenuOpen(false);
                    }}
                    type="button"
                  >
                    /{skill.skillId}
                    <small>{skill.description}</small>
                  </button>
                );
              })}
              <button
                disabled={uploadingAttachment}
                onClick={() => {
                  fileInput.current?.click();
                  setMenuOpen(false);
                }}
                type="button"
              >
                <Paperclip size={13} />
                {uploadingAttachment ? '正在上传…' : '添加附件'}
              </button>
            </div>
          ) : null}
          {running ? (
            <button
              className="send-behavior"
              onClick={() => { setSendMode(sendMode === 'steering' ? 'follow-up' : 'steering'); }}
              type="button"
            >
              {sendMode === 'steering' ? '立即调整当前工作' : '完成后继续'}
              <ChevronDown size={11} />
            </button>
          ) : null}
        </div>
        {threadRunning ? (
          <ComposerPrimitive.Cancel asChild>
            <button aria-label="停止" className="send-button" type="button">
              <Square size={13} />
            </button>
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send asChild>
            <button aria-label="发送" className="send-button" type="submit">
              <ArrowUp size={17} />
            </button>
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}

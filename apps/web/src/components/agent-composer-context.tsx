'use client';

import {
  FileText,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Paperclip,
  WandSparkles,
  Workflow,
  X,
} from 'lucide-react';
import { useState } from 'react';

import type { ArticleSelectionView } from './article-selection';
import type { PendingDirective } from '../lib/agentpress-assistant-runtime';
import type { AttachmentView } from './agent-view-model';

export function ComposerPendingDirectives({
  directives,
  onCancel,
  onError,
}: {
  readonly directives: readonly PendingDirective[];
  readonly onCancel: (directive: PendingDirective) => Promise<void>;
  readonly onError: (message: string) => void;
}): React.JSX.Element | null {
  const [cancellingId, setCancellingId] = useState<string>();
  if (directives.length === 0) return null;

  return (
    <div className="composer-pending" aria-label="待处理的补充要求">
      {directives.map((directive) => (
        <span className={`pending-directive pending-${directive.kind}`} key={directive.id}>
          <ListChecks aria-hidden="true" size={12} />
          <span>
            <small>{directive.kind === 'steering' ? '待应用' : '完成后继续'}</small>
            {directive.content}
          </span>
          <button
            aria-label="撤销这条补充要求"
            disabled={cancellingId === directive.id}
            onClick={() => {
              setCancellingId(directive.id);
              void onCancel(directive)
                .catch(() => {
                  onError('这条补充要求未能撤销，请稍后重试。');
                })
                .finally(() => {
                  setCancellingId(undefined);
                });
            }}
            type="button"
          >
            {cancellingId === directive.id ? (
              <LoaderCircle className="is-spinning" size={11} />
            ) : (
              <X size={11} />
            )}
          </button>
        </span>
      ))}
    </div>
  );
}

export function ComposerContextRow({
  activeArticleTitle,
  articleSelection,
  articles,
  attachments,
  contextLabel,
  onArticleMentionChange,
  onAttachmentRemove,
  onSelectionIncludedChange,
  onSkillChange,
  pendingReview,
  selectedArticleIds,
  selectedSkillKeys,
  selectionIncluded,
  uploadingAttachments,
}: {
  readonly activeArticleTitle?: string;
  readonly articleSelection?: ArticleSelectionView;
  readonly articles: readonly { readonly id: string; readonly title: string }[];
  readonly attachments: readonly AttachmentView[];
  readonly contextLabel?: string;
  readonly onArticleMentionChange: (value: readonly string[]) => void;
  readonly onAttachmentRemove: (id: string) => void;
  readonly onSelectionIncludedChange: (value: boolean) => void;
  readonly onSkillChange: (value: readonly string[]) => void;
  readonly pendingReview: boolean;
  readonly selectedArticleIds: readonly string[];
  readonly selectedSkillKeys: readonly string[];
  readonly selectionIncluded: boolean;
  readonly uploadingAttachments: number;
}): React.JSX.Element {
  return (
    <div className="composer-context" aria-label="本次对话上下文">
      {activeArticleTitle ? (
        <ContextIndicator
          icon={<FileText aria-hidden="true" size={12} />}
          label={`当前：${activeArticleTitle}`}
        />
      ) : null}
      {contextLabel ? (
        <ContextIndicator
          icon={<Workflow aria-hidden="true" size={12} />}
          label={contextLabel}
        />
      ) : null}
      {pendingReview ? (
        <ContextIndicator
          icon={<LockKeyhole aria-hidden="true" size={12} />}
          label="正文修改待审阅"
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
  );
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

function ContextIndicator({
  icon,
  label,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
}): React.JSX.Element {
  return (
    <span className="composer-context-chip is-fixed">
      {icon}
      <span>{label}</span>
    </span>
  );
}

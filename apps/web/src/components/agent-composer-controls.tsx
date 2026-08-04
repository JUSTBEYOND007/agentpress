'use client';

import { AuiIf, ComposerPrimitive } from '@assistant-ui/react';
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  ListChecks,
  Mic,
  WandSparkles,
} from 'lucide-react';

import type { AgentSendMode } from '../lib/agentpress-assistant-runtime';

export function ComposerTriggerMenu({ heading }: { readonly heading: string }): React.JSX.Element {
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

export function ComposerDictationControl(): React.JSX.Element {
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

export function ComposerSendModeControl({
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

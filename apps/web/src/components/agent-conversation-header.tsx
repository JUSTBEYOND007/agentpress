'use client';

import { Archive, ChevronDown, MoreHorizontal, Plus } from 'lucide-react';
import { useState } from 'react';

import { statusLabel, statusTone, type ConversationView } from './agent-view-model';

export function AgentConversationHeader({
  conversations,
  onCreate,
  onSelect,
  onUpdate,
  selected,
  status,
}: {
  readonly conversations: readonly ConversationView[];
  readonly onCreate: () => void;
  readonly onSelect: (conversation: ConversationView) => void;
  readonly onUpdate: (
    conversation: ConversationView,
    update: { title?: string; archived?: boolean },
  ) => void;
  readonly selected?: ConversationView;
  readonly status: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rename = (): void => {
    if (!selected) return;
    const title = window.prompt('重命名对话', selected.title)?.trim();
    if (title) onUpdate(selected, { title });
  };
  return (
    <header className="agent-header">
      <div className="conversation-picker">
        <button aria-expanded={open} onClick={() => { setOpen((value) => !value); }} type="button">
          <strong>{selected?.title ?? '写作助手'}</strong>
          <ChevronDown aria-hidden="true" size={14} />
        </button>
        {open ? (
          <div className="conversation-menu">
            {conversations
              .filter(({ archivedAt }) => !archivedAt)
              .map((conversation) => (
                <button
                  key={conversation.id}
                  onClick={() => {
                    onSelect(conversation);
                    setOpen(false);
                  }}
                  type="button"
                >
                  <span>{conversation.title}</span>
                  {conversation.isDefault ? <small>默认</small> : null}
                </button>
              ))}
            <button
              className="conversation-new"
              onClick={() => {
                onCreate();
                setOpen(false);
              }}
              type="button"
            >
              <Plus size={13} /> 新对话
            </button>
          </div>
        ) : null}
      </div>
      <span className={`status-dot status-${statusTone(status)}`}>{statusLabel(status)}</span>
      <button aria-label="重命名对话" className="header-icon-button" onClick={rename} type="button">
        <MoreHorizontal size={15} />
      </button>
      {selected && !selected.isDefault ? (
        <button
          aria-label="归档对话"
          className="header-icon-button"
          onClick={() => { onUpdate(selected, { archived: true }); }}
          type="button"
        >
          <Archive size={14} />
        </button>
      ) : null}
    </header>
  );
}

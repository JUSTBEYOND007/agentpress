'use client';

import { Archive, Check, ChevronDown, Pencil, Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  friendlyFailure,
  statusLabel,
  statusTone,
  type ConversationView,
} from './agent-view-model';
import { AgentBranchNavigator } from './agent-branch-navigator';

export function AgentConversationHeader({
  conversations,
  onCreate,
  onClose,
  onSelect,
  onUpdate,
  selected,
  status,
}: {
  readonly conversations: readonly ConversationView[];
  readonly onCreate: () => Promise<void>;
  readonly onClose?: () => void;
  readonly onSelect: (conversation: ConversationView) => void;
  readonly onUpdate: (
    conversation: ConversationView,
    update: { title?: string; archived?: boolean },
  ) => Promise<void>;
  readonly selected?: ConversationView;
  readonly status: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const matching = conversations.filter(
      ({ archivedAt, title }) =>
        !archivedAt && (!normalized || title.toLocaleLowerCase().includes(normalized)),
    );
    return [...new Map(matching.map((conversation) => [conversation.id, conversation])).values()];
  }, [conversations, query]);

  const run = async (action: () => Promise<void>, closeAfter = false): Promise<boolean> => {
    setPending(true);
    setError(undefined);
    try {
      await action();
      if (closeAfter) setOpen(false);
      return true;
    } catch (reason) {
      setError(friendlyFailure(reason, '操作没有完成，请重试。'));
      return false;
    } finally {
      setPending(false);
    }
  };

  return (
    <header className="agent-header">
      <div className="conversation-picker">
        <button
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
            setEditing(false);
            setArchiveConfirm(false);
            setError(undefined);
          }}
          type="button"
        >
          <strong>{selected?.title ?? '写作助手'}</strong>
          <ChevronDown aria-hidden="true" size={14} />
        </button>
        {open ? (
          <div className="conversation-menu">
            <div className="conversation-search">
              <Search aria-hidden="true" size={13} />
              <input
                aria-label="搜索对话"
                autoFocus
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder="搜索对话"
                value={query}
              />
            </div>
            <div className="conversation-list">
              {visible.map((conversation) => (
                <button
                  className={conversation.id === selected?.id ? 'is-selected' : ''}
                  key={`${conversation.id}:${conversation.branchId}`}
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
              {visible.length === 0 ? <p>没有匹配的对话</p> : null}
            </div>
            <button
              className="conversation-new"
              disabled={pending}
              onClick={() => {
                void run(onCreate, true);
              }}
              type="button"
            >
              <Plus size={13} /> 新对话
            </button>
            {selected ? (
              <div className="conversation-manage">
                {editing ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const title = renameValue.trim();
                      if (!title) return;
                      void run(() => onUpdate(selected, { title })).then((succeeded) => {
                        if (succeeded) setEditing(false);
                      });
                    }}
                  >
                    <input
                      aria-label="对话名称"
                      autoFocus
                      maxLength={120}
                      onChange={(event) => {
                        setRenameValue(event.target.value);
                      }}
                      value={renameValue}
                    />
                    <button
                      aria-label="保存名称"
                      disabled={pending || !renameValue.trim()}
                      title="保存"
                      type="submit"
                    >
                      <Check size={13} />
                    </button>
                    <button
                      aria-label="取消重命名"
                      onClick={() => {
                        setEditing(false);
                      }}
                      title="取消"
                      type="button"
                    >
                      <X size={13} />
                    </button>
                  </form>
                ) : archiveConfirm ? (
                  <div className="archive-confirm">
                    <span>归档这个对话？</span>
                    <button
                      disabled={pending}
                      onClick={() => {
                        void run(() => onUpdate(selected, { archived: true }), true);
                      }}
                      type="button"
                    >
                      归档
                    </button>
                    <button
                      onClick={() => {
                        setArchiveConfirm(false);
                      }}
                      type="button"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setRenameValue(selected.title);
                        setEditing(true);
                      }}
                      type="button"
                    >
                      <Pencil size={13} /> 重命名
                    </button>
                    {!selected.isDefault ? (
                      <button
                        onClick={() => {
                          setArchiveConfirm(true);
                        }}
                        type="button"
                      >
                        <Archive size={13} /> 归档
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
            {error ? <p className="conversation-error">{error}</p> : null}
          </div>
        ) : null}
      </div>
      <AgentBranchNavigator
        conversations={conversations}
        onSelect={onSelect}
        {...(selected ? { selected } : {})}
      />
      <span className={`status-dot status-${statusTone(status)}`}>{statusLabel(status)}</span>
      {onClose ? (
        <button
          aria-label="关闭 Agent 面板"
          className="header-icon-button agent-mobile-close"
          onClick={onClose}
          title="关闭"
          type="button"
        >
          <X aria-hidden="true" size={15} />
        </button>
      ) : null}
    </header>
  );
}

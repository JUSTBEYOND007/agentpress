'use client';

import { ChevronLeft, ChevronRight, GitBranch } from 'lucide-react';

import type { ConversationView } from './agent-view-model';

export function AgentBranchNavigator({
  conversations,
  onSelect,
  selected,
}: {
  readonly conversations: readonly ConversationView[];
  readonly onSelect: (conversation: ConversationView) => void;
  readonly selected?: ConversationView;
}): React.JSX.Element | null {
  const view = branchNavigationView(conversations, selected);
  if (!selected || view.branches.length <= 1) return null;
  return (
    <nav className="branch-navigator" aria-label="对话分支">
      <button
        aria-label="上一个分支"
        disabled={!view.previous}
        onClick={() => {
          if (view.previous) onSelect(view.previous);
        }}
        type="button"
      >
        <ChevronLeft size={13} />
      </button>
      <span title={selected.forkedFromMessageId ?? undefined}>
        <GitBranch size={11} /> {view.index + 1}/{view.branches.length}
      </span>
      <button
        aria-label="下一个分支"
        disabled={!view.next}
        onClick={() => {
          if (view.next) onSelect(view.next);
        }}
        type="button"
      >
        <ChevronRight size={13} />
      </button>
    </nav>
  );
}

export function branchNavigationView(
  conversations: readonly ConversationView[],
  selected?: ConversationView,
) {
  const branches = selected
    ? conversations
        .filter(({ id }) => id === selected.id)
        .sort((left, right) =>
          (left.branchCreatedAt ?? '').localeCompare(right.branchCreatedAt ?? ''),
        )
    : [];
  const index = branches.findIndex(({ branchId }) => branchId === selected?.branchId);
  return {
    branches,
    index,
    previous: index > 0 ? branches[index - 1] : undefined,
    next: index >= 0 ? branches[index + 1] : undefined,
  };
}

import type { ConversationView } from './agent-view-model';

export type ConversationSelection = {
  readonly conversationId: string;
  readonly branchId: string;
};

export type ConversationSelectionResolution = {
  readonly current?: ConversationSelection;
  readonly initial?: ConversationSelection;
  readonly persisted?: ConversationSelection;
  readonly firstLoad: boolean;
};

export function conversationSelectionStorageKey(articleId: string): string {
  return `agentpress:conversation-selection:${articleId}`;
}

export function readConversationSelection(articleId: string): ConversationSelection | undefined {
  try {
    const raw = window.localStorage.getItem(conversationSelectionStorageKey(articleId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as unknown;
    if (!isSelection(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function writeConversationSelection(
  articleId: string,
  selection: ConversationSelection,
): void {
  try {
    window.localStorage.setItem(conversationSelectionStorageKey(articleId), JSON.stringify(selection));
  } catch {
    // A blocked storage backend must not make the Agent workbench unusable.
  }
}

export function chooseConversation(
  conversations: readonly ConversationView[],
  candidates: readonly (ConversationSelection | undefined)[],
): ConversationView | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = conversations.find(
      ({ id, branchId }) => id === candidate.conversationId && branchId === candidate.branchId,
    );
    if (match) return match;
  }
  return conversations.find(({ isDefault }) => isDefault) ?? conversations[0];
}

export function resolveConversationSelection(
  conversations: readonly ConversationView[],
  resolution: ConversationSelectionResolution,
): ConversationView | undefined {
  return chooseConversation(
    conversations,
    resolution.firstLoad
      ? [resolution.persisted, resolution.initial]
      : [resolution.current, resolution.persisted, resolution.initial],
  );
}

function isSelection(value: unknown): value is ConversationSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return typeof candidate.conversationId === 'string' && typeof candidate.branchId === 'string';
}

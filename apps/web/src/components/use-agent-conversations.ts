'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../lib/authenticated-fetch';
import {
  readConversationSelection,
  resolveConversationSelection,
  writeConversationSelection,
  type ConversationSelection,
} from './agent-conversation-selection';
import type { ConversationView } from './agent-view-model';

export function useAgentConversations(input: {
  readonly apiUrl: string;
  readonly workspaceId?: string;
  readonly articleId?: string;
  readonly initialConversationId?: string;
  readonly initialBranchId?: string;
}) {
  const [conversations, setConversations] = useState<readonly ConversationView[]>([]);
  const [selected, setSelected] = useState<ConversationView>();
  const [error, setError] = useState<string>();
  const markingRead = useRef(new Set<string>());
  const scopeId =
    input.articleId ?? (input.workspaceId ? `workspace:${input.workspaceId}` : undefined);
  const conversationUrl = conversationCollectionUrl(input);
  const activeScopeId = useRef(scopeId);
  const resolvedSelection = useRef<
    { readonly scopeId: string; readonly selection?: ConversationSelection } | undefined
  >(undefined);
  activeScopeId.current = scopeId;

  const initialSelection = useMemo(
    () =>
      input.initialConversationId && input.initialBranchId
        ? {
            conversationId: input.initialConversationId,
            branchId: input.initialBranchId,
          }
        : undefined,
    [input.initialBranchId, input.initialConversationId],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!scopeId || !conversationUrl) {
      setConversations([]);
      setSelected(undefined);
      resolvedSelection.current = undefined;
      return;
    }
    const response = await authenticatedFetch(conversationUrl);
    if (!response.ok) throw new Error('对话列表加载失败');
    const items = (await response.json()) as readonly ConversationView[];
    if (activeScopeId.current !== scopeId) return;
    const currentResolution = resolvedSelection.current;
    const firstLoad = currentResolution?.scopeId !== scopeId;
    const persisted = readConversationSelection(scopeId);
    const next = resolveConversationSelection(items, {
      firstLoad,
      ...(persisted ? { persisted } : {}),
      ...(initialSelection ? { initial: initialSelection } : {}),
      ...(!firstLoad && currentResolution.selection
        ? { current: currentResolution.selection }
        : {}),
    });
    setConversations(items);
    setSelected(next);
    resolvedSelection.current = {
      scopeId,
      ...(next ? { selection: { conversationId: next.id, branchId: next.branchId } } : {}),
    };
    if (next) {
      writeConversationSelection(scopeId, {
        conversationId: next.id,
        branchId: next.branchId,
      });
    }
    setError(undefined);
  }, [conversationUrl, initialSelection, scopeId]);

  useEffect(() => {
    void refresh().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : '对话列表加载失败');
    });
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    }, 5000);
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!selected?.unread) return;
    const key = `${selected.id}:${selected.branchId}`;
    if (markingRead.current.has(key)) return;
    markingRead.current.add(key);
    void authenticatedFetch(
      `${input.apiUrl}/conversations/${selected.id}/branches/${selected.branchId}/read`,
      { method: 'POST' },
    )
      .then((response) => {
        if (!response.ok) throw new Error('对话已读状态更新失败');
        setConversations((current) =>
          current.map((item) =>
            item.id === selected.id && item.branchId === selected.branchId
              ? { ...item, unread: false }
              : item,
          ),
        );
        setSelected((current) => (current ? { ...current, unread: false } : current));
      })
      .catch(() => undefined)
      .finally(() => {
        markingRead.current.delete(key);
      });
  }, [input.apiUrl, selected]);

  const select = useCallback(
    (conversation: ConversationView): void => {
      if (!scopeId) return;
      const selection = { conversationId: conversation.id, branchId: conversation.branchId };
      resolvedSelection.current = { scopeId, selection };
      setSelected(conversation);
      writeConversationSelection(scopeId, selection);
    },
    [scopeId],
  );

  const create = useCallback(async (): Promise<void> => {
    if (!scopeId || !conversationUrl) return;
    const response = await authenticatedFetch(conversationUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新对话' }),
    });
    if (!response.ok) throw new Error(await response.text());
    const created = (await response.json()) as ConversationView;
    setConversations((current) => [created, ...current]);
    select(created);
  }, [conversationUrl, scopeId, select]);

  const update = useCallback(
    async (
      target: ConversationView,
      change: { readonly title?: string; readonly archived?: boolean },
    ): Promise<void> => {
      const response = await authenticatedFetch(`${input.apiUrl}/conversations/${target.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
      });
      if (!response.ok) throw new Error(await response.text());
      await refresh();
    },
    [input.apiUrl, refresh],
  );

  return {
    conversations,
    selected,
    select,
    create,
    update,
    refresh,
    error,
  };
}

export function conversationCollectionUrl(input: {
  readonly apiUrl: string;
  readonly workspaceId?: string;
  readonly articleId?: string;
}): string | undefined {
  if (input.articleId) return `${input.apiUrl}/articles/${input.articleId}/conversations`;
  if (input.workspaceId) return `${input.apiUrl}/workspaces/${input.workspaceId}/conversations`;
  return undefined;
}

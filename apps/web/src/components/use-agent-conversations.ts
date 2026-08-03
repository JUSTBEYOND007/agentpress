'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../lib/authenticated-fetch';
import type { ConversationView } from './agent-view-model';

export function useAgentConversations(input: {
  readonly apiUrl: string;
  readonly articleId?: string;
  readonly initialConversationId?: string;
  readonly initialBranchId?: string;
}) {
  const [conversations, setConversations] = useState<readonly ConversationView[]>([]);
  const [selected, setSelected] = useState<ConversationView | undefined>(
    input.initialConversationId && input.initialBranchId
      ? {
          id: input.initialConversationId,
          branchId: input.initialBranchId,
          title: '写作助手',
          isDefault: true,
        }
      : undefined,
  );
  const [error, setError] = useState<string>();
  const markingRead = useRef(new Set<string>());

  const refresh = useCallback(async (): Promise<void> => {
    if (!input.articleId) {
      setConversations([]);
      setSelected(undefined);
      return;
    }
    const response = await authenticatedFetch(
      `${input.apiUrl}/articles/${input.articleId}/conversations`,
    );
    if (!response.ok) throw new Error('对话列表加载失败');
    const items = (await response.json()) as readonly ConversationView[];
    setConversations(items);
    setSelected(
      (current) =>
        items.find(({ id, branchId }) => id === current?.id && branchId === current.branchId) ??
        items.find(
          ({ id, branchId }) =>
            id === input.initialConversationId && branchId === input.initialBranchId,
        ) ??
        items.find(({ isDefault }) => isDefault) ??
        items[0],
    );
    setError(undefined);
  }, [input.apiUrl, input.articleId, input.initialBranchId, input.initialConversationId]);

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

  const create = useCallback(async (): Promise<void> => {
    if (!input.articleId) return;
    const response = await authenticatedFetch(
      `${input.apiUrl}/articles/${input.articleId}/conversations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '新对话' }),
      },
    );
    if (!response.ok) throw new Error(await response.text());
    const created = (await response.json()) as ConversationView;
    setConversations((current) => [created, ...current]);
    setSelected(created);
  }, [input.apiUrl, input.articleId]);

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
    select: setSelected,
    create,
    update,
    refresh,
    error,
  };
}

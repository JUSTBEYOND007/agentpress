'use client';

import { fetchEventSource } from '@microsoft/fetch-event-source';
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';

import { authenticatedFetch } from './authenticated-fetch';
import { updateLiveRunContent, type LiveRunContent } from './agent-streaming';
import { numberValue, parseEventData, stringValue } from './agent-runtime-api';
import type { RunProjection } from './agent-runtime-contracts';
import {
  articleReviewChangeFromPayload,
  isTerminalRunEvent,
  type ArticleReviewChange,
} from './run-event-effects';

export function useAgentRunStream({
  activeRunId,
  apiUrl,
  lastEventIds,
  notifyArticleReviewChanged,
  refreshProjection,
  refreshThread,
  runModes,
  setActiveRunId,
  setLiveContent,
  setPanelError,
  setProjections,
}: {
  readonly activeRunId?: string;
  readonly apiUrl: string;
  readonly lastEventIds: RefObject<Map<string, number>>;
  readonly notifyArticleReviewChanged: (change: ArticleReviewChange) => void;
  readonly refreshProjection: (runId: string) => Promise<RunProjection>;
  readonly refreshThread: () => Promise<void>;
  readonly runModes: RefObject<Map<string, RunProjection['mode']>>;
  readonly setActiveRunId: Dispatch<SetStateAction<string | undefined>>;
  readonly setLiveContent: Dispatch<SetStateAction<readonly LiveRunContent[]>>;
  readonly setPanelError: Dispatch<SetStateAction<string | undefined>>;
  readonly setProjections: Dispatch<SetStateAction<readonly RunProjection[]>>;
}): void {
  useEffect(() => {
    if (!activeRunId) return;
    const stream = new AbortController();
    let refreshing = false;
    let refreshAgain = false;
    const sync = async (): Promise<void> => {
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        const projection = await refreshProjection(activeRunId);
        setPanelError(undefined);
        if (projection.terminal) {
          setActiveRunId(undefined);
          await refreshThread();
          stream.abort();
        }
      } catch (error) {
        if (!stream.signal.aborted)
          setPanelError(error instanceof Error ? error.message : '运行状态同步失败');
      } finally {
        refreshing = false;
        if (refreshAgain && !stream.signal.aborted) {
          refreshAgain = false;
          void sync();
        }
      }
    };
    void fetchEventSource(`${apiUrl}/runs/${activeRunId}/events`, {
      signal: stream.signal,
      fetch: authenticatedFetch,
      openWhenHidden: true,
      headers: { 'Last-Event-ID': String(lastEventIds.current.get(activeRunId) ?? 0) },
      onopen: async (response) => {
        if (!response.ok) throw new Error(`事件流连接失败 (${String(response.status)})`);
        setPanelError(undefined);
        await sync();
      },
      onmessage: (event) => {
        if (event.event === 'heartbeat') return;
        const data = parseEventData(event.data);
        if (
          event.event === 'content.delta' ||
          event.event === 'message.started' ||
          event.event === 'turn.started'
        ) {
          setLiveContent((current) =>
            updateLiveRunContent(current, {
              runId: activeRunId,
              mode: runModes.current.get(activeRunId) ?? 'direct',
              eventType: event.event,
              ...(stringValue(data.delta) ? { delta: stringValue(data.delta) } : {}),
            }),
          );
        }
        if (event.event === 'content.delta') return;
        if (isTerminalRunEvent(event.event)) {
          setPanelError(undefined);
          // Refresh the durable projection first. Applying terminal state to the
          // previous parts briefly renders a stale message tree and causes a
          // visible reorder before the final transcript is available.
          void sync();
          return;
        }
        const sequence = numberValue(data.sequence);
        const previous = lastEventIds.current.get(activeRunId) ?? 0;
        if (sequence > 0 && sequence <= previous) return;
        if (sequence > 0) lastEventIds.current.set(activeRunId, sequence);
        if (event.event === 'article.proposal.created') {
          const change = articleReviewChangeFromPayload(data);
          if (change) notifyArticleReviewChanged(change);
        }
        void sync();
      },
      onerror: (error) => {
        setPanelError('连接中断，正在恢复实时状态…');
        throw error;
      },
      onclose: () => {
        void sync();
      },
    }).catch((error: unknown) => {
      if (!stream.signal.aborted) {
        setPanelError(error instanceof Error ? error.message : 'Agent 事件流连接失败');
        void sync();
      }
    });
    return () => {
      stream.abort();
    };
  }, [
    activeRunId,
    apiUrl,
    lastEventIds,
    notifyArticleReviewChanged,
    refreshProjection,
    refreshThread,
    runModes,
    setActiveRunId,
    setLiveContent,
    setPanelError,
    setProjections,
  ]);
}

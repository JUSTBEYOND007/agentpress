'use client';

import {
  WebSpeechDictationAdapter,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { clearLiveRunContent, updateLiveRunContent, type LiveRunContent } from './agent-streaming';
import { authenticatedFetch } from './authenticated-fetch';
import {
  articleReviewChangeFromPart,
  articleReviewChangeFromPayload,
  isTerminalRunEvent,
  takeUnseenArticleReviewChange,
  terminalRunStatus,
  type ArticleReviewChange,
} from './run-event-effects';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export type AgentSendMode = 'steering' | 'follow-up';

export type RunPart = {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type:
    | 'text'
    | 'reasoning'
    | 'plan'
    | 'action-proposal'
    | 'activity'
    | 'tool-approval'
    | 'ask-user'
    | 'evidence'
    | 'article-change'
    | 'artifact'
    | 'warning'
    | 'recovery'
    | 'usage';
  readonly status: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type RunProjection = {
  readonly runId: string;
  readonly rootMessageId: string;
  readonly status: string;
  readonly terminal: boolean;
  readonly mode: 'direct' | 'planned';
  readonly activePlanRevision?: number;
  readonly parts: readonly RunPart[];
  readonly artifacts: readonly Readonly<Record<string, unknown>>[];
  readonly pendingInteraction?: Readonly<Record<string, unknown>>;
  readonly pendingDirectives: readonly PendingDirective[];
  readonly lastEventId: number;
  readonly createdAt: string;
  readonly completedAt?: string;
};

export type PendingDirective = {
  readonly id: string;
  readonly kind: 'steering' | 'follow_up';
  readonly content: string;
  readonly sequence: number;
  readonly createdAt: string;
};

export type AgentContextBinding =
  | { readonly type: 'mention'; readonly targetId: string }
  | { readonly type: 'attachment'; readonly attachmentId: string }
  | { readonly type: 'evidence'; readonly evidenceId: string }
  | {
      readonly type: 'article_selection';
      readonly articleId: string;
      readonly revisionId: string;
      readonly blocks: readonly { readonly blockId: string; readonly contentHash: string }[];
    }
  | { readonly type: 'skill'; readonly skillId: string; readonly version: string };

type StableMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
};

type AgentMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text?: string;
  readonly projection?: RunProjection;
  readonly status?: 'running' | 'complete' | 'error';
};

export type AgentRuntimeReadiness =
  | { readonly status: 'checking'; readonly missing: readonly string[] }
  | { readonly status: 'ready'; readonly missing: readonly string[] }
  | { readonly status: 'unavailable'; readonly missing: readonly string[] };

export function useAgentPressAssistantRuntime(
  sendMode: AgentSendMode,
  context: {
    readonly conversationId?: string;
    readonly branchId?: string;
    readonly mentionTargetIds?: readonly string[];
    readonly attachmentIds?: readonly string[];
    readonly skills?: readonly { readonly skillId: string; readonly version: string }[];
    readonly contextBindings?: readonly AgentContextBinding[];
    readonly sendingDisabled?: boolean;
    readonly beforeSend?: () => Promise<void>;
    readonly onArticleReviewChanged?: (articleId?: string) => Promise<void>;
  } = {},
) {
  const conversationId = context.conversationId;
  const branchId = context.branchId;
  const mentionTargetIds = context.mentionTargetIds ?? [];
  const attachmentIds = context.attachmentIds ?? [];
  const selectedSkills = context.skills ?? [];
  const contextBindings = context.contextBindings ?? [];
  const sendingDisabled = context.sendingDisabled ?? false;
  const [stableMessages, setStableMessages] = useState<readonly StableMessage[]>([]);
  const [optimisticMessages, setOptimisticMessages] = useState<readonly AgentMessage[]>([]);
  const [projections, setProjections] = useState<readonly RunProjection[]>([]);
  const [liveContent, setLiveContent] = useState<readonly LiveRunContent[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [readiness, setReadiness] = useState<AgentRuntimeReadiness>({
    status: 'checking',
    missing: [],
  });
  const [panelError, setPanelError] = useState<string>();
  const [submissionSequence, setSubmissionSequence] = useState(0);
  const lastEventIds = useRef(new Map<string, number>());
  const runModes = useRef(new Map<string, RunProjection['mode']>());
  const notifiedArticleProposals = useRef(new Set<string>());
  const onArticleReviewChangedRef = useRef(context.onArticleReviewChanged);

  useEffect(() => {
    onArticleReviewChangedRef.current = context.onArticleReviewChanged;
  }, [context.onArticleReviewChanged]);

  const notifyArticleReviewChanged = useCallback((change: ArticleReviewChange): void => {
    if (!takeUnseenArticleReviewChange(notifiedArticleProposals.current, change)) return;
    void onArticleReviewChangedRef.current?.(change.articleId).catch(() => undefined);
  }, []);

  const refreshProjection = useCallback(
    async (runId: string): Promise<RunProjection> => {
      const response = await authenticatedFetch(`${apiUrl}/runs/${runId}/projection`);
      if (!response.ok) throw new Error(`运行状态加载失败 (${String(response.status)})`);
      const projection = (await response.json()) as RunProjection;
      lastEventIds.current.set(runId, projection.lastEventId);
      runModes.current.set(runId, projection.mode);
      setProjections((current) => upsertProjection(current, projection));
      for (const part of projection.parts) {
        const change = articleReviewChangeFromPart(part);
        if (change) notifyArticleReviewChanged(change);
      }
      if (projection.mode === 'planned' || projection.terminal) {
        setLiveContent((current) => clearLiveRunContent(current, runId));
      }
      return projection;
    },
    [notifyArticleReviewChanged],
  );

  useEffect(() => {
    if (!conversationId || !branchId) {
      setStableMessages([]);
      setProjections([]);
      setLiveContent([]);
      setActiveRunId(undefined);
      return;
    }
    let active = true;
    setPanelError(undefined);
    void Promise.all([
      authenticatedFetch(`${apiUrl}/conversations/${conversationId}/branches/${branchId}/messages`),
      authenticatedFetch(`${apiUrl}/conversations/${conversationId}/branches/${branchId}/runs`),
    ])
      .then(async ([messageResponse, runResponse]) => {
        if (!messageResponse.ok)
          throw new Error(`对话历史加载失败 (${String(messageResponse.status)})`);
        if (!runResponse.ok) throw new Error(`运行历史加载失败 (${String(runResponse.status)})`);
        return Promise.all([
          messageResponse.json() as Promise<readonly StableMessage[]>,
          runResponse.json() as Promise<readonly RunProjection[]>,
        ]);
      })
      .then(([history, runs]) => {
        if (!active) return;
        setStableMessages(history);
        setOptimisticMessages([]);
        setProjections(runs);
        for (const run of runs) {
          lastEventIds.current.set(run.runId, run.lastEventId);
          runModes.current.set(run.runId, run.mode);
        }
        const activeRun = [...runs].reverse().find((run) => !run.terminal);
        setActiveRunId(activeRun?.runId);
      })
      .catch((error: unknown) => {
        if (active) setPanelError(error instanceof Error ? error.message : '对话历史加载失败');
      });
    return () => {
      active = false;
    };
  }, [branchId, conversationId]);

  useEffect(() => {
    let active = true;
    void fetch(`${apiUrl}/health/agent-runtime`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`运行环境检查失败 (${String(response.status)})`);
        return (await response.json()) as { readonly ready?: unknown; readonly missing?: unknown };
      })
      .then((result) => {
        if (!active) return;
        const missing = Array.isArray(result.missing)
          ? result.missing.filter((value): value is string => typeof value === 'string')
          : [];
        setReadiness(
          result.ready === true ? { status: 'ready', missing } : { status: 'unavailable', missing },
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        setReadiness({ status: 'unavailable', missing: [] });
        setPanelError(error instanceof Error ? error.message : '无法检查 Agent 运行环境');
      });
    return () => {
      active = false;
    };
  }, []);

  const activeProjection = projections.find(({ runId }) => runId === activeRunId);

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
        if (event.event === 'content.delta') {
          return;
        }
        if (isTerminalRunEvent(event.event)) {
          setPanelError(undefined);
          setProjections((current) =>
            current.map((projection) =>
              projection.runId === activeRunId
                ? {
                    ...projection,
                    status: terminalRunStatus(event.event),
                    terminal: true,
                  }
                : projection,
            ),
          );
          setLiveContent((current) => clearLiveRunContent(current, activeRunId));
          setActiveRunId(undefined);
          stream.abort();
          void refreshProjection(activeRunId);
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
  }, [activeRunId, notifyArticleReviewChanged, refreshProjection]);

  const messages = useMemo(
    () => [...buildRunTurns(stableMessages, projections, liveContent), ...optimisticMessages],
    [liveContent, optimisticMessages, projections, stableMessages],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const prompt = messageText(message);
      if (!prompt || !conversationId || !branchId) return;
      const optimisticId = crypto.randomUUID();
      setOptimisticMessages((current) => [
        ...current,
        { id: optimisticId, role: 'user', text: prompt },
      ]);
      setPanelError(undefined);
      try {
        await context.beforeSend?.();
        if (activeProjection && !activeProjection.terminal) {
          const endpoint = sendMode === 'steering' ? 'steering' : 'follow-ups';
          await request(`${apiUrl}/runs/${activeProjection.runId}/${endpoint}`, {
            content: prompt,
          });
          setOptimisticMessages((current) => current.filter(({ id }) => id !== optimisticId));
          setSubmissionSequence((value) => value + 1);
          await refreshProjection(activeProjection.runId);
          return;
        }
        const created = await request(
          `${apiUrl}/conversations/${conversationId}/runs`,
          {
            branchId,
            prompt,
            contextBindings: [
              ...contextBindings,
              ...mentionTargetIds.map((targetId) => ({ type: 'mention', targetId })),
              ...attachmentIds.map((attachmentId) => ({ type: 'attachment', attachmentId })),
              ...selectedSkills.map(({ skillId, version }) => ({
                type: 'skill',
                skillId,
                version,
              })),
            ],
          },
          true,
        );
        const runId = stringValue(created.runId);
        const messageId = stringValue(created.messageId);
        if (!runId || !messageId) throw new Error('创建运行的响应不完整');
        setStableMessages((current) => [
          ...current,
          { id: messageId, role: 'user', content: prompt },
        ]);
        setOptimisticMessages((current) => current.filter(({ id }) => id !== optimisticId));
        setActiveRunId(runId);
        setSubmissionSequence((value) => value + 1);
        await refreshProjection(runId);
      } catch (error) {
        setOptimisticMessages((current) => current.filter(({ id }) => id !== optimisticId));
        setPanelError(error instanceof Error ? error.message : '消息发送失败');
      }
    },
    [
      activeProjection,
      attachmentIds,
      branchId,
      conversationId,
      contextBindings,
      context.beforeSend,
      mentionTargetIds,
      refreshProjection,
      selectedSkills,
      sendMode,
    ],
  );

  const onCancel = useCallback(async () => {
    if (activeRunId) await request(`${apiUrl}/runs/${activeRunId}/cancel`, {});
  }, [activeRunId]);

  const cancelDirective = useCallback(
    async (directive: PendingDirective): Promise<void> => {
      if (!activeRunId) return;
      const endpoint =
        directive.kind === 'steering'
          ? `steering/${directive.id}/cancel`
          : `follow-ups/${directive.id}/cancel`;
      await request(`${apiUrl}/runs/${activeRunId}/${endpoint}`, {});
      await refreshProjection(activeRunId);
    },
    [activeRunId, refreshProjection],
  );

  const decideTool = useCallback(
    async (toolCallId: string, decision: 'approved' | 'denied') => {
      await request(`${apiUrl}/tool-calls/${toolCallId}/approval`, { decision });
      if (activeRunId) await refreshProjection(activeRunId);
    },
    [activeRunId, refreshProjection],
  );

  const answerQuestion = useCallback(
    async (runId: string, questionId: string, answer: string) => {
      await request(`${apiUrl}/runs/${runId}/questions/${questionId}/answer`, { answer });
      setActiveRunId(runId);
      await refreshProjection(runId);
    },
    [refreshProjection],
  );

  const decideActionProposal = useCallback(
    async (proposalId: string, decision: 'confirmed' | 'rejected') => {
      const result = await request(
        `${apiUrl}/action-proposals/${proposalId}/${decision === 'confirmed' ? 'confirm' : 'reject'}`,
        {},
      );
      if (activeRunId) await refreshProjection(activeRunId);
      const confirmedRunId = stringValue(result.confirmedRunId);
      if (confirmedRunId) {
        setActiveRunId(confirmedRunId);
        await refreshProjection(confirmedRunId);
      }
      return result;
    },
    [activeRunId, refreshProjection],
  );

  const isRunning = Boolean(activeProjection && !activeProjection.terminal);
  const dictation = useMemo(
    () => new WebSpeechDictationAdapter({ language: 'zh-CN', continuous: true }),
    [],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    onNew,
    onCancel,
    adapters: { dictation },
    isSendDisabled: readiness.status !== 'ready' || !conversationId || !branchId || sendingDisabled,
    isRunning,
  });

  return {
    runtime,
    projections,
    activeProjection,
    decideTool,
    answerQuestion,
    decideActionProposal,
    cancelDirective,
    readiness,
    panelError,
    isRunning,
    submissionSequence,
  };
}

function buildRunTurns(
  messages: readonly StableMessage[],
  projections: readonly RunProjection[],
  liveContent: readonly { readonly runId: string; readonly text: string }[],
): readonly AgentMessage[] {
  const byRoot = new Map(projections.map((projection) => [projection.rootMessageId, projection]));
  const liveByRunId = new Map(liveContent.map((content) => [content.runId, content.text]));
  const projectedRunIds = new Set(projections.map(({ runId }) => runId));
  const result: AgentMessage[] = [];
  let skipNextAssistant = false;
  for (const message of messages) {
    if (message.role === 'assistant' && skipNextAssistant) {
      skipNextAssistant = false;
      continue;
    }
    result.push({ id: message.id, role: message.role, text: message.content, status: 'complete' });
    if (message.role !== 'user') continue;
    const projection = byRoot.get(message.id);
    if (!projection) continue;
    const liveText = liveByRunId.get(projection.runId);
    result.push({
      id: `run:${projection.runId}`,
      role: 'assistant',
      projection,
      ...(liveText ? { text: liveText } : {}),
      status: projection.terminal ? 'complete' : 'running',
    });
    skipNextAssistant = projectedRunIds.has(projection.runId);
  }
  return result;
}

function convertMessage(message: AgentMessage): ThreadMessageLike {
  const projection = message.projection;
  const content = projection
    ? projectionContent(projection, message.text)
    : [{ type: 'text' as const, text: message.text ?? '' }];
  return {
    id: message.id,
    role: message.role,
    content,
    ...(message.role === 'assistant'
      ? {
          status:
            message.status === 'running'
              ? ({ type: 'running' } as const)
              : message.status === 'error'
                ? ({ type: 'incomplete', reason: 'error' } as const)
                : ({ type: 'complete', reason: 'stop' } as const),
        }
      : {}),
  };
}

function projectionContent(
  projection: RunProjection,
  liveText?: string,
): ThreadMessageLike['content'] {
  const parts: (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'data'; readonly name: string; readonly data: unknown }
  )[] = [];
  for (const part of [...projection.parts].sort((left, right) => left.sequence - right.sequence)) {
    if (part.type === 'text') {
      const message = recordValue(part.payload.message);
      const text = stringValue(message.content) || stringValue(part.payload.content);
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    parts.push({ type: 'data', name: 'agentpress-run-part', data: part });
  }
  if (liveText && !projection.parts.some(({ type }) => type === 'text')) {
    parts.push({ type: 'text', text: liveText });
  }
  if (
    projection.artifacts.length > 0 &&
    !projection.parts.some(({ type }) => type === 'artifact')
  ) {
    parts.push({
      type: 'data',
      name: 'agentpress-run-part',
      data: {
        id: `${projection.runId}:artifacts`,
        runId: projection.runId,
        sequence: projection.lastEventId + 1,
        type: 'artifact',
        status: 'artifact.available',
        payload: { artifacts: projection.artifacts },
      } satisfies RunPart,
    });
  }
  if (parts.length === 0 || !projection.terminal) {
    parts.unshift({
      type: 'data',
      name: 'agentpress-run-part',
      data: {
        id: `${projection.runId}:status`,
        runId: projection.runId,
        sequence: 0,
        type: 'activity',
        status: `run.${projection.status}`,
        payload: { mode: projection.mode, activePlanRevision: projection.activePlanRevision },
      } satisfies RunPart,
    });
  }
  return parts;
}

function upsertProjection(
  current: readonly RunProjection[],
  projection: RunProjection,
): readonly RunProjection[] {
  return [...current.filter(({ runId }) => runId !== projection.runId), projection].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

function messageText(message: AppendMessage): string {
  return message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim();
}

async function request(
  url: string,
  body: unknown,
  idempotent = false,
): Promise<Record<string, unknown>> {
  const response = await authenticatedFetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(idempotent ? { 'idempotency-key': crypto.randomUUID() } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `请求失败 (${String(response.status)})`);
  }
  return recordValue((await response.json()) as unknown);
}

function parseEventData(value: string): Record<string, unknown> {
  try {
    return recordValue(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

export function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

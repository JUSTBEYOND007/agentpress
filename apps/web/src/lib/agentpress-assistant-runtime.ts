'use client';

import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from './authenticated-fetch';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export type AgentSendMode = 'steering' | 'follow-up';

export type RunPart = {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type:
    | 'text'
    | 'plan'
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
  readonly mode: 'direct' | 'planned';
  readonly activePlanRevision?: number;
  readonly parts: readonly RunPart[];
  readonly artifacts: readonly Readonly<Record<string, unknown>>[];
  readonly pendingInteraction?: Readonly<Record<string, unknown>>;
  readonly lastEventId: number;
  readonly createdAt: string;
  readonly completedAt?: string;
};

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

const ACTIVE_RUN_STATES = new Set([
  'queued',
  'planning',
  'running',
  'waiting_for_approval',
  'waiting_for_user',
  'recovering',
  'cancelling',
]);

export function useAgentPressAssistantRuntime(
  sendMode: AgentSendMode,
  context: {
    readonly conversationId?: string;
    readonly branchId?: string;
    readonly mentionTargetIds?: readonly string[];
    readonly attachmentIds?: readonly string[];
    readonly skills?: readonly { readonly skillId: string; readonly version: string }[];
  } = {},
) {
  const conversationId = context.conversationId;
  const branchId = context.branchId;
  const mentionTargetIds = context.mentionTargetIds ?? [];
  const attachmentIds = context.attachmentIds ?? [];
  const selectedSkills = context.skills ?? [];
  const [stableMessages, setStableMessages] = useState<readonly StableMessage[]>([]);
  const [optimisticMessages, setOptimisticMessages] = useState<readonly AgentMessage[]>([]);
  const [projections, setProjections] = useState<readonly RunProjection[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [readiness, setReadiness] = useState<AgentRuntimeReadiness>({
    status: 'checking',
    missing: [],
  });
  const [panelError, setPanelError] = useState<string>();
  const lastEventIds = useRef(new Map<string, number>());

  const refreshProjection = useCallback(async (runId: string): Promise<RunProjection> => {
    const response = await authenticatedFetch(`${apiUrl}/runs/${runId}/projection`);
    if (!response.ok) throw new Error(`运行状态加载失败 (${String(response.status)})`);
    const projection = (await response.json()) as RunProjection;
    lastEventIds.current.set(runId, projection.lastEventId);
    setProjections((current) => upsertProjection(current, projection));
    return projection;
  }, []);

  useEffect(() => {
    if (!conversationId || !branchId) {
      setStableMessages([]);
      setProjections([]);
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
        for (const run of runs) lastEventIds.current.set(run.runId, run.lastEventId);
        const activeRun = [...runs].reverse().find((run) => ACTIVE_RUN_STATES.has(run.status));
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
        if (!ACTIVE_RUN_STATES.has(projection.status)) {
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
        const sequence = numberValue(data.sequence);
        const previous = lastEventIds.current.get(activeRunId) ?? 0;
        if (sequence > 0 && sequence <= previous) return;
        if (sequence > 0) lastEventIds.current.set(activeRunId, sequence);
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
  }, [activeRunId, refreshProjection]);

  const messages = useMemo(
    () => [...buildRunTurns(stableMessages, projections), ...optimisticMessages],
    [optimisticMessages, projections, stableMessages],
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
        if (activeProjection && ACTIVE_RUN_STATES.has(activeProjection.status)) {
          const endpoint = sendMode === 'steering' ? 'steering' : 'follow-ups';
          await request(`${apiUrl}/runs/${activeProjection.runId}/${endpoint}`, {
            content: prompt,
          });
          return;
        }
        const created = await request(
          `${apiUrl}/conversations/${conversationId}/runs`,
          {
            branchId,
            prompt,
            contextBindings: [
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
      mentionTargetIds,
      refreshProjection,
      selectedSkills,
      sendMode,
    ],
  );

  const onCancel = useCallback(async () => {
    if (activeRunId) await request(`${apiUrl}/runs/${activeRunId}/cancel`, {});
  }, [activeRunId]);

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

  const decideProposal = useCallback(
    async (proposalId: string, decisions: Readonly<Record<string, 'accepted' | 'rejected'>>) => {
      const result = await request(`${apiUrl}/edit-proposals/${proposalId}/decisions`, {
        decisions,
      });
      if (activeRunId) await refreshProjection(activeRunId);
      return result;
    },
    [activeRunId, refreshProjection],
  );

  const isRunning = Boolean(activeProjection && ACTIVE_RUN_STATES.has(activeProjection.status));
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    onNew,
    onCancel,
    isSendDisabled: readiness.status !== 'ready' || !conversationId || !branchId,
    isRunning,
  });

  return {
    runtime,
    projections,
    activeProjection,
    decideTool,
    answerQuestion,
    decideProposal,
    readiness,
    panelError,
    isRunning,
  };
}

function buildRunTurns(
  messages: readonly StableMessage[],
  projections: readonly RunProjection[],
): readonly AgentMessage[] {
  const byRoot = new Map(projections.map((projection) => [projection.rootMessageId, projection]));
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
    result.push({
      id: `run:${projection.runId}`,
      role: 'assistant',
      projection,
      status: ACTIVE_RUN_STATES.has(projection.status) ? 'running' : 'complete',
    });
    skipNextAssistant = projectedRunIds.has(projection.runId);
  }
  return result;
}

function convertMessage(message: AgentMessage): ThreadMessageLike {
  const projection = message.projection;
  const content = projection
    ? projectionContent(projection)
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

function projectionContent(projection: RunProjection): ThreadMessageLike['content'] {
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
  if (parts.length === 0 || ACTIVE_RUN_STATES.has(projection.status)) {
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

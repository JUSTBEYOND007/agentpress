'use client';

import {
  WebSpeechDictationAdapter,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalThreadQueueAdapter,
} from '@assistant-ui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { clearLiveRunContent, type LiveRunContent } from './agent-streaming';
import { loadAgentThreadSnapshot, type StableAgentMessage } from './agent-thread-snapshot';
import { authenticatedFetch } from './authenticated-fetch';
import { messageText, requestAgentApi, runDirectivePath, stringValue } from './agent-runtime-api';
import type {
  AgentContextBinding,
  AgentMessage,
  AgentRuntimeReadiness,
  AgentSendMode,
  PendingDirective,
  RunProjection,
} from './agent-runtime-contracts';
import { buildRunTurns, convertAgentMessage, upsertProjection } from './agent-runtime-projection';
import {
  articleReviewChangeFromPart,
  takeUnseenArticleReviewChange,
  type ArticleReviewChange,
} from './run-event-effects';
import { useAgentRunStream } from './use-agent-run-stream';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export type {
  AgentContextBinding,
  AgentRuntimeReadiness,
  AgentSendMode,
  PendingDirective,
  RunPart,
  RunProjection,
} from './agent-runtime-contracts';
export { numberValue, recordValue, runDirectivePath, stringValue } from './agent-runtime-api';

export function useAgentPressAssistantRuntime(
  context: {
    readonly conversationId?: string;
    readonly branchId?: string;
    readonly mentionTargetIds?: readonly string[];
    readonly attachmentIds?: readonly string[];
    readonly skills?: readonly { readonly skillId: string; readonly version: string }[];
    readonly contextBindings?: readonly AgentContextBinding[];
    readonly sendingDisabled?: boolean;
    readonly beforeSend?: () => Promise<void>;
    readonly beforeSendReady?: boolean;
    readonly onArticleReviewChanged?: (articleId?: string) => Promise<void>;
    readonly onBranchForked?: (branchId: string, forkedFromMessageId: string) => void;
  } = {},
) {
  const conversationId = context.conversationId;
  const branchId = context.branchId;
  const mentionTargetIds = context.mentionTargetIds ?? [];
  const attachmentIds = context.attachmentIds ?? [];
  const selectedSkills = context.skills ?? [];
  const contextBindings = context.contextBindings ?? [];
  const sendingDisabled = context.sendingDisabled ?? false;
  const [stableMessages, setStableMessages] = useState<readonly StableAgentMessage[]>([]);
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
  const beforeSendError = useRef<string | undefined>(undefined);
  const onArticleReviewChangedRef = useRef(context.onArticleReviewChanged);
  const threadKey = conversationId && branchId ? `${conversationId}:${branchId}` : undefined;
  const currentThreadKey = useRef(threadKey);
  currentThreadKey.current = threadKey;

  useEffect(() => {
    onArticleReviewChangedRef.current = context.onArticleReviewChanged;
  }, [context.onArticleReviewChanged]);

  useEffect(() => {
    if (!context.beforeSendReady || !beforeSendError.current) return;
    const recoveredError = beforeSendError.current;
    beforeSendError.current = undefined;
    setPanelError((current) => (current === recoveredError ? undefined : current));
  }, [context.beforeSendReady]);

  const prepareBeforeSend = useCallback(async (): Promise<void> => {
    try {
      await context.beforeSend?.();
      beforeSendError.current = undefined;
    } catch (error) {
      beforeSendError.current = error instanceof Error ? error.message : '正文草稿尚未同步';
      throw error;
    }
  }, [context.beforeSend]);

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

  const refreshThread = useCallback(async (): Promise<void> => {
    if (!conversationId || !branchId || !threadKey) return;
    const snapshot = await loadAgentThreadSnapshot(apiUrl, conversationId, branchId);
    if (currentThreadKey.current !== threadKey) return;
    setStableMessages(snapshot.messages);
    setOptimisticMessages([]);
    setProjections(snapshot.runs);
    for (const run of snapshot.runs) {
      lastEventIds.current.set(run.runId, run.lastEventId);
      runModes.current.set(run.runId, run.mode);
    }
    const activeRun = [...snapshot.runs].reverse().find((run) => !run.terminal);
    setActiveRunId(activeRun?.runId);
  }, [branchId, conversationId, threadKey]);

  useEffect(() => {
    if (!threadKey) {
      setStableMessages([]);
      setProjections([]);
      setLiveContent([]);
      setActiveRunId(undefined);
      return;
    }
    let active = true;
    setPanelError(undefined);
    void refreshThread().catch((error: unknown) => {
      if (active) setPanelError(error instanceof Error ? error.message : '对话历史加载失败');
    });
    return () => {
      active = false;
    };
  }, [refreshThread, threadKey]);

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

  useAgentRunStream({
    ...(activeRunId ? { activeRunId } : {}),
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
  });

  const messages = useMemo(
    () => [...buildRunTurns(stableMessages, projections, liveContent), ...optimisticMessages],
    [liveContent, optimisticMessages, projections, stableMessages],
  );

  const submitMessage = useCallback(
    async (message: AppendMessage, requestedMode?: AgentSendMode) => {
      const prompt = messageText(message);
      if (!prompt || !conversationId || !branchId) return;
      const optimisticId = crypto.randomUUID();
      setOptimisticMessages((current) => [
        ...current,
        { id: optimisticId, role: 'user', text: prompt },
      ]);
      setPanelError(undefined);
      try {
        await prepareBeforeSend();
        if (activeProjection && !activeProjection.terminal) {
          await requestAgentApi(
            `${apiUrl}/${runDirectivePath(activeProjection.runId, requestedMode)}`,
            {
              content: prompt,
            },
          );
          setOptimisticMessages((current) => current.filter(({ id }) => id !== optimisticId));
          setSubmissionSequence((value) => value + 1);
          await refreshProjection(activeProjection.runId);
          return;
        }
        const created = await requestAgentApi(
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
      mentionTargetIds,
      prepareBeforeSend,
      refreshProjection,
      selectedSkills,
    ],
  );

  const isRunning = Boolean(activeProjection && !activeProjection.terminal);
  const onCancel = useCallback(async () => {
    if (!activeRunId || activeProjection?.status === 'cancelling') return;
    await requestAgentApi(`${apiUrl}/runs/${activeRunId}/cancel`, {});
    await refreshProjection(activeRunId);
  }, [activeProjection?.status, activeRunId, refreshProjection]);

  const onReload = useCallback(
    async (parentId: string | null) => {
      if (!parentId || !conversationId || !branchId || isRunning) return;
      const source = stableMessages.find(({ id, role }) => id === parentId && role === 'user');
      if (!source) return;
      setPanelError(undefined);
      try {
        await prepareBeforeSend();
        const fork = await requestAgentApi(
          `${apiUrl}/conversations/${conversationId}/branches/${branchId}/fork`,
          { messageId: parentId },
        );
        const nextBranchId = stringValue(fork.branchId);
        const forkedMessageId = stringValue(fork.forkedMessageId);
        if (!nextBranchId || !forkedMessageId) throw new Error('创建对话分支的响应不完整');
        await requestAgentApi(
          `${apiUrl}/conversations/${conversationId}/runs`,
          {
            branchId: nextBranchId,
            prompt: source.content,
            existingMessageId: forkedMessageId,
            contextBindings,
          },
          true,
        );
        context.onBranchForked?.(nextBranchId, parentId);
      } catch (error) {
        setPanelError(error instanceof Error ? error.message : '重新生成失败');
      }
    },
    [
      branchId,
      context,
      contextBindings,
      conversationId,
      isRunning,
      prepareBeforeSend,
      stableMessages,
    ],
  );

  const cancelDirective = useCallback(
    async (directive: PendingDirective): Promise<void> => {
      if (!activeRunId) return;
      const endpoint =
        directive.kind === 'steering'
          ? `steering/${directive.id}/cancel`
          : `follow-ups/${directive.id}/cancel`;
      await requestAgentApi(`${apiUrl}/runs/${activeRunId}/${endpoint}`, {});
      await refreshProjection(activeRunId);
    },
    [activeRunId, refreshProjection],
  );

  const queue = useMemo<ExternalThreadQueueAdapter>(
    () => ({
      items: (activeProjection?.pendingDirectives ?? []).map(({ id, content }) => ({
        id,
        prompt: content,
      })),
      enqueue: (message, options) => {
        void submitMessage(message, options.steer ? 'steering' : 'follow-up');
      },
      steer: () => {
        // AgentPress exposes steering before persistence, not as a lossy conversion
        // of an already persisted follow-up.
      },
      remove: (queueItemId) => {
        const directive = activeProjection?.pendingDirectives.find(({ id }) => id === queueItemId);
        if (directive) void cancelDirective(directive);
      },
      clear: () => {
        // Cancelling the durable Run settles its pending directives atomically.
      },
    }),
    [activeProjection?.pendingDirectives, cancelDirective, submitMessage],
  );

  const decideTool = useCallback(
    async (toolCallId: string, decision: 'approved' | 'denied') => {
      await requestAgentApi(`${apiUrl}/tool-calls/${toolCallId}/approval`, { decision });
      if (activeRunId) await refreshProjection(activeRunId);
    },
    [activeRunId, refreshProjection],
  );

  const answerQuestion = useCallback(
    async (runId: string, questionId: string, answer: string) => {
      await requestAgentApi(`${apiUrl}/runs/${runId}/questions/${questionId}/answer`, { answer });
      setActiveRunId(runId);
      await refreshProjection(runId);
    },
    [refreshProjection],
  );

  const decideActionProposal = useCallback(
    async (proposalId: string, decision: 'confirmed' | 'rejected') => {
      const result = await requestAgentApi(
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

  const dictation = useMemo(
    () => new WebSpeechDictationAdapter({ language: 'zh-CN', continuous: true }),
    [],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: convertAgentMessage,
    onNew: submitMessage,
    onCancel,
    onReload,
    queue,
    adapters: { dictation },
    isSendDisabled:
      readiness.status !== 'ready' ||
      !conversationId ||
      !branchId ||
      sendingDisabled ||
      activeProjection?.status === 'cancelling',
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

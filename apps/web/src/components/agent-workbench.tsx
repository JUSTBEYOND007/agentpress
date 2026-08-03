'use client';

import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AgentComposer } from './agent-composer';
import type { ArticleSelectionView } from './article-selection';
import { AgentConversationHeader } from './agent-conversation-header';
import { RunActionsContext, type RunActions } from './agent-run-parts';
import { AgentThread } from './agent-thread';
import type { AttachmentView, ConversationView, MemoryView, SkillView } from './agent-view-model';
import { authenticatedFetch } from '../lib/authenticated-fetch';
import {
  useAgentPressAssistantRuntime,
  type AgentContextBinding,
  type PendingDirective,
  type AgentSendMode,
} from '../lib/agentpress-assistant-runtime';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export function AgentWorkbench({
  conversationId,
  branchId,
  onArticleReviewChanged,
  onClose,
  workspaceId,
  activeArticleId,
  activeArticleTitle,
  articleSelection,
  articles,
  beforeSend,
}: {
  readonly conversationId?: string;
  readonly branchId?: string;
  readonly onArticleReviewChanged?: (articleId?: string) => Promise<void>;
  readonly onClose?: () => void;
  readonly workspaceId?: string;
  readonly activeArticleId?: string;
  readonly activeArticleTitle?: string;
  readonly articleSelection?: ArticleSelectionView;
  readonly beforeSend?: () => Promise<void>;
  readonly articles: readonly {
    readonly id: string;
    readonly revisionId: string;
    readonly title: string;
  }[];
}): React.JSX.Element {
  const [sendMode, setSendMode] = useState<AgentSendMode>('steering');
  const [skills, setSkills] = useState<readonly SkillView[]>([]);
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<readonly string[]>([]);
  const [mentionActiveArticle, setMentionActiveArticle] = useState(false);
  const [selectedArticleIds, setSelectedArticleIds] = useState<readonly string[]>([]);
  const [selectionIncluded, setSelectionIncluded] = useState(Boolean(articleSelection));
  const [attachments, setAttachments] = useState<readonly AttachmentView[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [memories, setMemories] = useState<readonly MemoryView[]>([]);
  const [contextError, setContextError] = useState<string>();
  const [conversations, setConversations] = useState<readonly ConversationView[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<ConversationView | undefined>(
    conversationId && branchId
      ? { id: conversationId, branchId, title: '写作助手', isDefault: true }
      : undefined,
  );
  const selectedSkills = useMemo(
    () =>
      skills
        .filter((skill) => selectedSkillKeys.includes(`${skill.skillId}@${skill.version}`))
        .map(({ skillId, version }) => ({ skillId, version })),
    [selectedSkillKeys, skills],
  );
  useEffect(() => {
    setSelectionIncluded(Boolean(articleSelection));
  }, [articleSelection]);
  useEffect(() => {
    setSelectedArticleIds((current) => current.filter((id) => id !== activeArticleId));
  }, [activeArticleId]);
  const contextBindings = useMemo<readonly AgentContextBinding[]>(
    () => [
      ...(mentionActiveArticle && activeArticleId
        ? [{ type: 'mention' as const, targetId: activeArticleId }]
        : []),
      ...selectedArticleIds.map((targetId) => ({ type: 'mention' as const, targetId })),
      ...(selectionIncluded && articleSelection
        ? [
            {
              type: 'article_selection' as const,
              articleId: articleSelection.articleId,
              revisionId: articleSelection.revisionId,
              blocks: articleSelection.blocks,
            },
          ]
        : []),
      ...attachments.map(({ id }) => ({ type: 'attachment' as const, attachmentId: id })),
      ...selectedSkills.map(({ skillId, version }) => ({
        type: 'skill' as const,
        skillId,
        version,
      })),
    ],
    [
      activeArticleId,
      articleSelection,
      attachments,
      mentionActiveArticle,
      selectedArticleIds,
      selectedSkills,
      selectionIncluded,
    ],
  );
  const {
    runtime,
    activeProjection,
    decideTool,
    answerQuestion,
    decideActionProposal,
    cancelDirective,
    readiness,
    panelError,
    isRunning,
    submissionSequence,
  } = useAgentPressAssistantRuntime(
    sendMode,
    selectedConversation
      ? {
          conversationId: selectedConversation.id,
          branchId: selectedConversation.branchId,
          contextBindings,
          sendingDisabled: uploadingAttachments > 0,
          ...(onArticleReviewChanged ? { onArticleReviewChanged } : {}),
          ...(beforeSend ? { beforeSend } : {}),
        }
      : {},
  );

  useEffect(() => {
    if (submissionSequence === 0) return;
    setAttachments([]);
    setAttachmentError(undefined);
  }, [submissionSequence]);

  useEffect(() => {
    if (!conversationId || !branchId) return;
    setSelectedConversation((current) =>
      current?.id === conversationId
        ? current
        : { id: conversationId, branchId, title: '写作助手', isDefault: true },
    );
  }, [branchId, conversationId]);

  const loadContext = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    try {
      const [skillResponse, memoryResponse] = await Promise.all([
        authenticatedFetch(`${apiUrl}/workspaces/${workspaceId}/skills`),
        authenticatedFetch(`${apiUrl}/workspaces/${workspaceId}/memories`),
      ]);
      if (!skillResponse.ok || !memoryResponse.ok) throw new Error('Agent 上下文加载失败');
      setSkills((await skillResponse.json()) as SkillView[]);
      setMemories((await memoryResponse.json()) as MemoryView[]);
      setContextError(undefined);
    } catch (error) {
      setContextError(error instanceof Error ? error.message : 'Agent 上下文加载失败');
    }
  }, [workspaceId]);

  const loadConversations = useCallback(async (): Promise<void> => {
    if (!activeArticleId) return;
    const response = await authenticatedFetch(
      `${apiUrl}/articles/${activeArticleId}/conversations`,
    );
    if (!response.ok) throw new Error('对话列表加载失败');
    const items = (await response.json()) as readonly ConversationView[];
    setConversations(items);
    setSelectedConversation(
      (current) =>
        items.find(({ id }) => id === current?.id) ??
        items.find(({ id }) => id === conversationId) ??
        items.find(({ isDefault }) => isDefault) ??
        items[0],
    );
  }, [activeArticleId, conversationId]);

  useEffect(() => {
    void loadContext();
    void loadConversations().catch((error: unknown) => {
      setContextError(error instanceof Error ? error.message : '对话列表加载失败');
    });
  }, [loadContext, loadConversations]);

  const createConversation = async (): Promise<void> => {
    if (!activeArticleId) return;
    const response = await authenticatedFetch(
      `${apiUrl}/articles/${activeArticleId}/conversations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '新对话' }),
      },
    );
    if (!response.ok) throw new Error(await response.text());
    const created = (await response.json()) as ConversationView;
    setConversations((current) => [created, ...current]);
    setSelectedConversation(created);
  };

  const updateConversation = async (
    target: ConversationView,
    update: { readonly title?: string; readonly archived?: boolean },
  ): Promise<void> => {
    const response = await authenticatedFetch(`${apiUrl}/conversations/${target.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    });
    if (!response.ok) throw new Error(await response.text());
    await loadConversations();
  };

  const decideMemory = async (candidateId: string, decision: 'accepted' | 'rejected') => {
    if (!workspaceId) return;
    const response = await authenticatedFetch(
      `${apiUrl}/workspaces/${workspaceId}/memories/${candidateId}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      },
    );
    if (!response.ok) throw new Error(await response.text());
    await loadContext();
  };

  const actions = useMemo<RunActions>(
    () => ({
      decideTool,
      answerQuestion,
      decideActionProposal,
    }),
    [answerQuestion, decideActionProposal, decideTool],
  );
  const status =
    activeProjection?.status ?? (readiness.status === 'ready' ? 'ready' : readiness.status);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RunActionsContext.Provider value={actions}>
        <aside className="agent-panel" aria-label="Agent 工作台">
          <AgentConversationHeader
            conversations={conversations}
            onCreate={createConversation}
            {...(onClose ? { onClose } : {})}
            onSelect={setSelectedConversation}
            onUpdate={updateConversation}
            {...(selectedConversation ? { selected: selectedConversation } : {})}
            status={status}
          />
          {panelError || contextError ? (
            <div className="agent-status-banner" role="status">
              {panelError ?? contextError}
            </div>
          ) : null}
          <ThreadPrimitive.Root className="aui-thread">
            <AgentThread memories={memories} onMemoryDecision={decideMemory} />
            <AgentComposer
              {...(activeArticleTitle ? { activeArticleTitle } : {})}
              {...(activeArticleId ? { activeArticleId } : {})}
              {...(articleSelection ? { articleSelection } : {})}
              articles={articles}
              attachments={attachments}
              {...(attachmentError ? { attachmentError } : {})}
              {...(selectedConversation ? { conversationId: selectedConversation.id } : {})}
              mentionActiveArticle={mentionActiveArticle}
              onArticleMentionChange={setSelectedArticleIds}
              onAttachmentRemove={(id) => {
                setAttachments((current) => current.filter((item) => item.id !== id));
              }}
              onAttachmentErrorDismiss={() => {
                setAttachmentError(undefined);
              }}
              onAttachmentUpload={async (files) => {
                if (!workspaceId) throw new Error('工作区尚未加载');
                const accepted = files.slice(0, Math.max(0, 10 - attachments.length));
                if (accepted.length === 0) {
                  setAttachmentError('每次对话最多添加 10 个附件，请先移除部分文件。');
                  return;
                }
                setUploadingAttachments((count) => count + accepted.length);
                setAttachmentError(undefined);
                const results = await Promise.allSettled(
                  accepted.map(async (file): Promise<AttachmentView> => {
                    const response = await authenticatedFetch(
                      `${apiUrl}/workspaces/${workspaceId}/attachments`,
                      {
                        method: 'POST',
                        headers: {
                          'content-type': file.type || 'text/plain',
                          'x-file-name': encodeURIComponent(file.name),
                        },
                        body: file,
                      },
                    );
                    if (!response.ok) throw new Error(await response.text());
                    const uploaded = (await response.json()) as AttachmentView & {
                      readonly parseStatus: string;
                      readonly parseFailure?: string;
                    };
                    if (uploaded.parseStatus !== 'ready')
                      throw new Error(uploaded.parseFailure ?? `${file.name} 解析失败`);
                    return uploaded;
                  }),
                );
                const uploaded = results.flatMap((result) =>
                  result.status === 'fulfilled' ? [result.value] : [],
                );
                const failed = results.flatMap((result) =>
                  result.status === 'rejected'
                    ? [result.reason instanceof Error ? result.reason.message : '附件上传失败']
                    : [],
                );
                setAttachments((current) => [...current, ...uploaded]);
                setUploadingAttachments((count) => Math.max(0, count - accepted.length));
                setAttachmentError(
                  failed.length > 0
                    ? `${String(failed.length)} 个附件未能添加，请检查格式或稍后重试。`
                    : undefined,
                );
              }}
              onMentionChange={setMentionActiveArticle}
              onPendingDirectiveCancel={async (directive: PendingDirective) => {
                await cancelDirective(directive);
              }}
              onSelectionIncludedChange={setSelectionIncluded}
              pendingDirectives={activeProjection?.pendingDirectives ?? []}
              selectedArticleIds={selectedArticleIds}
              selectionIncluded={selectionIncluded}
              onSkillChange={setSelectedSkillKeys}
              readiness={readiness.status}
              running={isRunning}
              selectedSkillKeys={selectedSkillKeys}
              sendMode={sendMode}
              setSendMode={setSendMode}
              skills={skills}
              uploadingAttachments={uploadingAttachments}
            />
          </ThreadPrimitive.Root>
        </aside>
      </RunActionsContext.Provider>
    </AssistantRuntimeProvider>
  );
}

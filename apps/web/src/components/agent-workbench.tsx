'use client';

import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AgentComposer } from './agent-composer';
import { AgentConversationHeader } from './agent-conversation-header';
import { RunActionsContext, type RunActions } from './agent-run-parts';
import { AgentThread } from './agent-thread';
import {
  showContextError,
  type AttachmentView,
  type ConversationView,
  type MemoryView,
  type SkillView,
} from './agent-view-model';
import { authenticatedFetch } from '../lib/authenticated-fetch';
import {
  useAgentPressAssistantRuntime,
  type AgentSendMode,
} from '../lib/agentpress-assistant-runtime';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export function AgentWorkbench({
  conversationId,
  branchId,
  onArticleUpdated,
  workspaceId,
  activeArticleId,
  activeArticleTitle,
}: {
  readonly conversationId?: string;
  readonly branchId?: string;
  readonly onArticleUpdated?: () => Promise<void>;
  readonly workspaceId?: string;
  readonly activeArticleId?: string;
  readonly activeArticleTitle?: string;
}): React.JSX.Element {
  const [sendMode, setSendMode] = useState<AgentSendMode>('steering');
  const [skills, setSkills] = useState<readonly SkillView[]>([]);
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<readonly string[]>([]);
  const [mentionActiveArticle, setMentionActiveArticle] = useState(true);
  const [attachments, setAttachments] = useState<readonly AttachmentView[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
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
  const mentionTargetIds = useMemo(
    () => (mentionActiveArticle && activeArticleId ? [activeArticleId] : []),
    [activeArticleId, mentionActiveArticle],
  );
  const {
    runtime,
    activeProjection,
    decideTool,
    answerQuestion,
    decideProposal,
    readiness,
    panelError,
    isRunning,
  } = useAgentPressAssistantRuntime(
    sendMode,
    selectedConversation
      ? {
          conversationId: selectedConversation.id,
          branchId: selectedConversation.branchId,
          ...(mentionTargetIds.length > 0 ? { mentionTargetIds } : {}),
          ...(attachments.length > 0 ? { attachmentIds: attachments.map(({ id }) => id) } : {}),
          ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
        }
      : {},
  );

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
      decideProposal,
      ...(onArticleUpdated ? { onArticleUpdated } : {}),
    }),
    [answerQuestion, decideProposal, decideTool, onArticleUpdated],
  );
  const status =
    activeProjection?.status ?? (readiness.status === 'ready' ? 'ready' : readiness.status);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RunActionsContext.Provider value={actions}>
        <aside className="agent-panel" aria-label="Agent 工作台">
          <AgentConversationHeader
            conversations={conversations}
            onCreate={() => void createConversation().catch(showContextError(setContextError))}
            onSelect={setSelectedConversation}
            onUpdate={(target, update) =>
              void updateConversation(target, update).catch(showContextError(setContextError))
            }
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
              attachments={attachments}
              mentionActiveArticle={mentionActiveArticle}
              onAttachmentRemove={(id) =>
                { setAttachments((current) => current.filter((item) => item.id !== id)); }
              }
              onAttachmentUpload={async (file) => {
                if (!workspaceId) throw new Error('工作区尚未加载');
                setUploadingAttachment(true);
                try {
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
                    throw new Error(uploaded.parseFailure ?? '附件解析失败');
                  setAttachments((current) => [...current, uploaded]);
                  setContextError(undefined);
                } catch (error) {
                  setContextError(error instanceof Error ? error.message : '附件上传失败');
                } finally {
                  setUploadingAttachment(false);
                }
              }}
              onMentionChange={setMentionActiveArticle}
              onSkillChange={setSelectedSkillKeys}
              readiness={readiness.status}
              running={isRunning}
              selectedSkillKeys={selectedSkillKeys}
              sendMode={sendMode}
              setSendMode={setSendMode}
              skills={skills}
              uploadingAttachment={uploadingAttachment}
            />
          </ThreadPrimitive.Root>
        </aside>
      </RunActionsContext.Provider>
    </AssistantRuntimeProvider>
  );
}

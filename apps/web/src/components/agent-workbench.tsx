'use client';

import type { DiffEntry, EditOperation } from '@agentpress/editor-patch';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Coins,
  FileCheck2,
  FileText,
  MoreHorizontal,
  Paperclip,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { ArticleDiff } from './article-diff';
import { authenticatedFetch } from '../lib/authenticated-fetch';
import {
  numberValue,
  recordValue,
  stringValue,
  useAgentPressAssistantRuntime,
  type AgentSendMode,
  type RunPart,
} from '../lib/agentpress-assistant-runtime';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

type RunActions = {
  readonly decideTool: (toolCallId: string, decision: 'approved' | 'denied') => Promise<void>;
  readonly answerQuestion: (runId: string, questionId: string, answer: string) => Promise<void>;
  readonly decideProposal: (
    proposalId: string,
    decisions: Readonly<Record<string, 'accepted' | 'rejected'>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly onArticleUpdated?: () => Promise<void>;
};

const RunActionsContext = createContext<RunActions | undefined>(undefined);

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
    const response = await authenticatedFetch(`${apiUrl}/articles/${activeArticleId}/conversations`);
    if (!response.ok) throw new Error('对话列表加载失败');
    const items = (await response.json()) as readonly ConversationView[];
    setConversations(items);
    setSelectedConversation((current) =>
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
    const response = await authenticatedFetch(`${apiUrl}/articles/${activeArticleId}/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新对话' }),
    });
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
    () => ({ decideTool, answerQuestion, decideProposal, ...(onArticleUpdated ? { onArticleUpdated } : {}) }),
    [answerQuestion, decideProposal, decideTool, onArticleUpdated],
  );
  const status = activeProjection?.status ?? (readiness.status === 'ready' ? 'ready' : readiness.status);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RunActionsContext.Provider value={actions}>
        <aside className="agent-panel" aria-label="Agent 工作台">
          <ConversationHeader
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
            <ThreadPrimitive.Viewport className="agent-thread">
              <ThreadPrimitive.Messages>
                {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
              </ThreadPrimitive.Messages>
              <MemoryCandidates memories={memories} onDecision={decideMemory} />
              <ThreadPrimitive.ViewportFooter className="thread-footer">
                <ThreadPrimitive.ScrollToBottom asChild>
                  <button className="scroll-button" aria-label="滚动到底部" type="button">
                    <ArrowDown aria-hidden="true" size={15} />
                  </button>
                </ThreadPrimitive.ScrollToBottom>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
            <AgentComposer
              {...(activeArticleTitle ? { activeArticleTitle } : {})}
              mentionActiveArticle={mentionActiveArticle}
              onMentionChange={setMentionActiveArticle}
              onSkillChange={setSelectedSkillKeys}
              readiness={readiness.status}
              running={isRunning}
              selectedSkillKeys={selectedSkillKeys}
              sendMode={sendMode}
              setSendMode={setSendMode}
              skills={skills}
            />
          </ThreadPrimitive.Root>
        </aside>
      </RunActionsContext.Provider>
    </AssistantRuntimeProvider>
  );
}

type SkillView = { readonly skillId: string; readonly version: string; readonly description: string };
type MemoryView = {
  readonly id: string;
  readonly subject: string;
  readonly value: string;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'superseded';
};
type ConversationView = {
  readonly id: string;
  readonly branchId: string;
  readonly title: string;
  readonly isDefault: boolean;
  readonly archivedAt?: string | null;
};

function ConversationHeader({ conversations, onCreate, onSelect, onUpdate, selected, status }: {
  readonly conversations: readonly ConversationView[];
  readonly onCreate: () => void;
  readonly onSelect: (conversation: ConversationView) => void;
  readonly onUpdate: (conversation: ConversationView, update: { title?: string; archived?: boolean }) => void;
  readonly selected?: ConversationView;
  readonly status: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rename = (): void => {
    if (!selected) return;
    const title = window.prompt('重命名对话', selected.title)?.trim();
    if (title) onUpdate(selected, { title });
  };
  return (
    <header className="agent-header">
      <div className="conversation-picker">
        <button aria-expanded={open} onClick={() => { setOpen((value) => !value); }} type="button">
          <strong>{selected?.title ?? '写作助手'}</strong>
          <ChevronDown aria-hidden="true" size={14} />
        </button>
        {open ? (
          <div className="conversation-menu">
            {conversations.filter(({ archivedAt }) => !archivedAt).map((conversation) => (
              <button key={conversation.id} onClick={() => { onSelect(conversation); setOpen(false); }} type="button">
                <span>{conversation.title}</span>
                {conversation.isDefault ? <small>默认</small> : null}
              </button>
            ))}
            <button className="conversation-new" onClick={() => { onCreate(); setOpen(false); }} type="button">
              <Plus size={13} /> 新对话
            </button>
          </div>
        ) : null}
      </div>
      <span className={`status-dot status-${statusTone(status)}`}>{statusLabel(status)}</span>
      <button aria-label="重命名对话" className="header-icon-button" onClick={rename} type="button">
        <MoreHorizontal size={15} />
      </button>
      {selected && !selected.isDefault ? (
        <button aria-label="归档对话" className="header-icon-button" onClick={() => { onUpdate(selected, { archived: true }); }} type="button">
          <Archive size={14} />
        </button>
      ) : null}
    </header>
  );
}

function UserMessage(): React.JSX.Element {
  return <MessagePrimitive.Root className="aui-message aui-user-message"><MessagePrimitive.Parts components={{ Text: MessageText }} /></MessagePrimitive.Root>;
}

function AssistantMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="aui-message aui-assistant-message">
      <div className="assistant-avatar" aria-hidden="true"><Sparkles size={13} /></div>
      <div className="assistant-content">
        <MessagePrimitive.Parts components={{ Text: MessageText, data: { by_name: { 'agentpress-run-part': RunPartRenderer } } }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function MessageText(): React.JSX.Element {
  return <MessagePartPrimitive.Text className="message-text" smooth />;
}

function RunPartRenderer({ data }: { readonly data: unknown }): React.JSX.Element | null {
  const part = parseRunPart(data);
  if (!part) return null;
  if (part.type === 'plan') return <PlanPart part={part} />;
  if (part.type === 'tool-approval') return <ApprovalPart part={part} />;
  if (part.type === 'ask-user') return <AskUserPart part={part} />;
  if (part.type === 'artifact') return <ArtifactPart part={part} />;
  if (part.type === 'evidence') return <EvidencePart part={part} />;
  if (part.type === 'article-change') return <ArticleChangePart part={part} />;
  if (part.type === 'usage') return <UsagePart part={part} />;
  if (part.type === 'warning' || part.type === 'recovery') return <NoticePart part={part} />;
  if (part.type === 'activity') {
    const proposal = proposalFromPart(part);
    return proposal ? <ArticleChangePart part={part} proposal={proposal} /> : <ActivityPart part={part} />;
  }
  return null;
}

function PlanPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const tasks = Array.isArray(part.payload.tasks) ? part.payload.tasks.map(recordValue) : [];
  return (
    <details className="run-part plan-part" open>
      <summary><Sparkles size={14} /> {stringValue(part.payload.summary) || '执行计划'}<small>v{numberValue(part.payload.revisionNumber) || 1}</small></summary>
      <ol>{tasks.map((task, index) => <li key={stringValue(task.id) || String(index)}><span className="task-state" /><div><strong>{stringValue(task.objective) || stringValue(task.label)}</strong><small>{stringValue(task.owner) || 'Specialist'} · {task.criticality === 'optional' ? '可选' : '必需'}</small></div></li>)}</ol>
    </details>
  );
}

function ActivityPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const payload = part.payload;
  const isTool = part.status.startsWith('tool.');
  const title = isTool
    ? stringValue(payload.toolId) || stringValue(payload.toolName) || '工具调用'
    : stringValue(payload.summary) || stringValue(payload.owner) || statusLabel(part.status);
  return (
    <details className="run-part activity-part">
      <summary>{isTool ? <Wrench size={13} /> : <Clock3 size={13} />}<span>{title}</span><small>{statusLabel(part.status)}</small></summary>
      <pre>{compactJson(payload)}</pre>
    </details>
  );
}

function ApprovalPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const actions = useRunActions();
  const toolCallId = stringValue(part.payload.toolCallId);
  const [decision, setDecision] = useState<'approved' | 'denied'>();
  return (
    <section className="run-part approval-row" aria-label="工具审批">
      <CircleAlert size={16} /><div><strong>需要你的确认</strong><span>{stringValue(part.payload.sideEffect) || stringValue(part.payload.toolId)}</span></div>
      <div><button disabled={Boolean(decision)} onClick={() => { setDecision('approved'); void actions.decideTool(toolCallId, 'approved'); }} type="button"><Check size={14} />允许</button><button disabled={Boolean(decision)} onClick={() => { setDecision('denied'); void actions.decideTool(toolCallId, 'denied'); }} type="button"><X size={14} />拒绝</button></div>
    </section>
  );
}

function AskUserPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const actions = useRunActions();
  const [answer, setAnswer] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const options = Array.isArray(part.payload.options) ? part.payload.options.filter((value): value is string => typeof value === 'string') : [];
  const submit = (value: string): void => {
    if (!value.trim() || submitted) return;
    setSubmitted(true);
    void actions.answerQuestion(part.runId, stringValue(part.payload.questionId), value).catch(() => { setSubmitted(false); });
  };
  return (
    <section className="run-part ask-user-part">
      <strong>{stringValue(part.payload.question) || '需要补充信息'}</strong>
      {options.length > 0 ? <div>{options.map((option) => <button disabled={submitted} key={option} onClick={() => { submit(option); }} type="button">{option}</button>)}</div> : null}
      <form onSubmit={(event) => { event.preventDefault(); submit(answer); }}><input aria-label="回答 Agent 的问题" disabled={submitted} onChange={(event) => { setAnswer(event.target.value); }} value={answer} /><button disabled={submitted || !answer.trim()} type="submit">回答</button></form>
    </section>
  );
}

function ArtifactPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const artifacts = Array.isArray(part.payload.artifacts) ? part.payload.artifacts.map(recordValue) : [part.payload];
  return <section className="run-part artifact-part"><h3><FileText size={14} />产出</h3>{artifacts.map((artifact, index) => <div key={stringValue(artifact.id) || stringValue(artifact.artifactId) || String(index)}><strong>{stringValue(artifact.title) || stringValue(artifact.type) || '结构化产物'}</strong><span>{stringValue(artifact.summary)}</span></div>)}</section>;
}

function EvidencePart({ part }: { readonly part: RunPart }): React.JSX.Element {
  return <section className="run-part evidence-part"><FileCheck2 size={14} /><strong>{stringValue(part.payload.title) || '引用来源'}</strong><span>{stringValue(part.payload.source)}</span></section>;
}

type Proposal = { readonly proposalId: string; readonly operations: readonly EditOperation[]; readonly diffs: readonly DiffEntry[] };

function ArticleChangePart({ part, proposal = proposalFromPart(part) }: { readonly part: RunPart; readonly proposal?: Proposal }): React.JSX.Element | null {
  const actions = useRunActions();
  const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const [submitting, setSubmitting] = useState(false);
  if (!proposal) return null;
  const allDecided = proposal.operations.every(({ operationId }) => decisions[operationId]);
  const decideAll = (decision: 'accepted' | 'rejected'): void => { setDecisions(Object.fromEntries(proposal.operations.map(({ operationId }) => [operationId, decision]))); };
  return (
    <section className="run-part proposal-preview">
      <div className="proposal-heading"><div><strong>文章修改</strong><span>{proposal.operations.length} 项</span></div><div><button onClick={() => { decideAll('accepted'); }} type="button">全部接受</button><button onClick={() => { decideAll('rejected'); }} type="button">全部拒绝</button></div></div>
      <ArticleDiff decisions={decisions} disabled={submitting} entries={proposal.diffs} onDecision={(operationId, decision) => { setDecisions((current) => ({ ...current, [operationId]: decision })); }} />
      <div className="proposal-submit-row"><span>逐项确认后应用到正文</span><button className="primary-action" disabled={!allDecided || submitting} onClick={() => { setSubmitting(true); void actions.decideProposal(proposal.proposalId, decisions).then(() => actions.onArticleUpdated?.()).finally(() => { setSubmitting(false); }); }} type="button">{submitting ? '应用中…' : '应用修改'}</button></div>
    </section>
  );
}

function NoticePart({ part }: { readonly part: RunPart }): React.JSX.Element {
  return <div className={`run-part notice-part notice-${part.type}`}><RotateCcw size={13} /><span>{stringValue(part.payload.message) || stringValue(recordValue(part.payload.failure).message) || statusLabel(part.status)}</span></div>;
}

function UsagePart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const usage = recordValue(part.payload.usage);
  const tokens = numberValue(usage.inputTokens) + numberValue(usage.outputTokens);
  return <details className="run-part usage-part"><summary><Coins size={13} />已完成 · {tokens.toLocaleString()} tokens</summary><pre>{compactJson(part.payload)}</pre></details>;
}

function AgentComposer({ activeArticleTitle, mentionActiveArticle, onMentionChange, onSkillChange, readiness, running, selectedSkillKeys, sendMode, setSendMode, skills }: {
  readonly activeArticleTitle?: string;
  readonly mentionActiveArticle: boolean;
  readonly onMentionChange: (value: boolean) => void;
  readonly onSkillChange: (value: readonly string[]) => void;
  readonly readiness: 'checking' | 'ready' | 'unavailable';
  readonly running: boolean;
  readonly selectedSkillKeys: readonly string[];
  readonly sendMode: AgentSendMode;
  readonly setSendMode: (mode: AgentSendMode) => void;
  readonly skills: readonly SkillView[];
}): React.JSX.Element {
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <ComposerPrimitive.Root className="agent-composer">
      <div className="composer-context">
        {activeArticleTitle ? <button className={mentionActiveArticle ? 'is-selected' : ''} onClick={() => { onMentionChange(!mentionActiveArticle); }} type="button">@ {activeArticleTitle}</button> : null}
        {selectedSkillKeys.map((key) => <button key={key} onClick={() => { onSkillChange(selectedSkillKeys.filter((item) => item !== key)); }} type="button">/ {key.split('@')[0]} <X size={10} /></button>)}
      </div>
      <ComposerPrimitive.Input aria-label="发送消息给 Agent" placeholder={readiness === 'ready' ? '提问或描述你希望完成的工作…' : readiness === 'checking' ? '正在连接…' : 'Agent 尚未配置'} rows={2} />
      <div className="composer-actions">
        <div className="composer-menu-wrap">
          <button aria-expanded={menuOpen} aria-label="添加上下文" className="composer-tool-button" onClick={() => { setMenuOpen((value) => !value); }} type="button"><Plus size={15} /></button>
          {menuOpen ? <div className="composer-menu"><strong>Skills</strong>{skills.map((skill) => { const key = `${skill.skillId}@${skill.version}`; return <button key={key} onClick={() => { if (!selectedSkillKeys.includes(key)) onSkillChange([...selectedSkillKeys, key]); setMenuOpen(false); }} type="button">/{skill.skillId}<small>{skill.description}</small></button>; })}<button disabled type="button"><Paperclip size={13} />添加附件</button></div> : null}
          {running ? <button className="send-behavior" onClick={() => { setSendMode(sendMode === 'steering' ? 'follow-up' : 'steering'); }} type="button">{sendMode === 'steering' ? '立即调整当前工作' : '完成后继续'}<ChevronDown size={11} /></button> : null}
        </div>
        {threadRunning ? <ComposerPrimitive.Cancel asChild><button aria-label="停止" className="send-button" type="button"><Square size={13} /></button></ComposerPrimitive.Cancel> : <ComposerPrimitive.Send asChild><button aria-label="发送" className="send-button" type="submit"><ArrowUp size={17} /></button></ComposerPrimitive.Send>}
      </div>
    </ComposerPrimitive.Root>
  );
}

function MemoryCandidates({ memories, onDecision }: { readonly memories: readonly MemoryView[]; readonly onDecision: (id: string, decision: 'accepted' | 'rejected') => Promise<void> }): React.JSX.Element | null {
  const pending = memories.filter(({ status }) => status === 'pending');
  if (pending.length === 0) return null;
  return <section className="memory-candidates"><strong>可保存的偏好</strong>{pending.map((memory) => <div className="memory-candidate" key={memory.id}><span>{memory.subject}：{memory.value}</span><button onClick={() => void onDecision(memory.id, 'accepted')} type="button">保存</button><button onClick={() => void onDecision(memory.id, 'rejected')} type="button">忽略</button></div>)}</section>;
}

function proposalFromPart(part: RunPart): Proposal | undefined {
  const output = recordValue(part.payload.output);
  const value = Object.keys(output).length > 0 ? output : part.payload;
  const proposalId = stringValue(value.proposalId);
  if (!proposalId || !Array.isArray(value.operations) || !Array.isArray(value.diffs)) return undefined;
  return { proposalId, operations: value.operations as readonly EditOperation[], diffs: value.diffs as readonly DiffEntry[] };
}

function parseRunPart(value: unknown): RunPart | undefined {
  const candidate = recordValue(value);
  const type = stringValue(candidate.type);
  const allowed = ['text', 'plan', 'activity', 'tool-approval', 'ask-user', 'evidence', 'article-change', 'artifact', 'warning', 'recovery', 'usage'] as const;
  if (!allowed.some((item) => item === type)) return undefined;
  return {
    id: stringValue(candidate.id),
    runId: stringValue(candidate.runId),
    sequence: numberValue(candidate.sequence),
    type: type as RunPart['type'],
    status: stringValue(candidate.status),
    payload: recordValue(candidate.payload),
  };
}

function useRunActions(): RunActions {
  const actions = useContext(RunActionsContext);
  if (!actions) throw new Error('Run actions are unavailable');
  return actions;
}

function compactJson(value: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1197)}…` : text;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = { ready: '就绪', checking: '连接中', unavailable: '未配置', queued: '排队中', planning: '规划中', running: '工作中', waiting_for_approval: '等待确认', waiting_for_user: '等待回答', recovering: '恢复中', completed: '已完成', completed_with_degradation: '已完成（有警告）', failed: '失败', cancelled: '已取消', 'run.started': '已开始', 'run.queued': '排队中', 'task.started': '进行中', 'task.succeeded': '已完成', 'task.failed': '失败', 'tool.proposed': '准备调用', 'tool.executing': '执行中', 'tool.succeeded': '已完成', 'tool.failed': '失败' };
  return labels[status] ?? status.replaceAll('_', ' ');
}

function statusTone(status: string): string {
  if (status.includes('fail') || status.includes('cancel') || status === 'unavailable') return 'danger';
  if (status.includes('waiting') || status.includes('recover')) return 'warning';
  if (status.includes('complete') || status === 'ready') return 'success';
  return 'active';
}

function showContextError(setError: (message: string) => void): (error: unknown) => void {
  return (error) => { setError(error instanceof Error ? error.message : '操作失败'); };
}

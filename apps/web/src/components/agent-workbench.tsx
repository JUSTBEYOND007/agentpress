'use client';

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Coins,
  FileCheck2,
  RotateCcw,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ArticleDiff } from './article-diff';
import { authenticatedFetch } from '../lib/authenticated-fetch';
import {
  useAgentPressAssistantRuntime,
  type AgentSendMode,
} from '../lib/agentpress-assistant-runtime';
import { initialRunView } from '../lib/run-event-reducer';

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
  const [memories, setMemories] = useState<readonly MemoryView[]>([]);
  const [contextError, setContextError] = useState<string>();
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
  const { runtime, run, decideTool, decideProposal, readiness } = useAgentPressAssistantRuntime(
    sendMode,
    conversationId || branchId
      ? {
          ...(conversationId ? { conversationId } : {}),
          ...(branchId ? { branchId } : {}),
          ...(mentionTargetIds.length > 0 ? { mentionTargetIds } : {}),
          ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
        }
      : {},
  );

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

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  useEffect(() => {
    if (run.tools.some((tool) => tool.name === 'memory.propose' && tool.status === 'succeeded'))
      void loadContext();
  }, [loadContext, run.tools]);

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
    if (!response.ok) {
      setContextError(await response.text());
      return;
    }
    await loadContext();
  };

  const createSkill = async (markdown: string): Promise<boolean> => {
    if (!workspaceId) return false;
    const response = await authenticatedFetch(`${apiUrl}/workspaces/${workspaceId}/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown }),
    });
    if (!response.ok) {
      setContextError(await response.text());
      return false;
    }
    await loadContext();
    return true;
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <aside className="agent-panel" aria-label="Agent 工作台">
        <header className="agent-header">
          <div>
            <strong>写作助手</strong>
            <span className={`status-dot status-${statusTone(run.status)}`}>{run.status}</span>
          </div>
        </header>

        <ThreadPrimitive.Root className="aui-thread">
          <ThreadPrimitive.Viewport className="agent-thread">
            <ThreadPrimitive.Messages>
              {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
            </ThreadPrimitive.Messages>
            {run.runId ? (
              <RunInspector
                {...(onArticleUpdated ? { onArticleUpdated } : {})}
                onProposalDecision={decideProposal}
                onToolDecision={decideTool}
                run={run}
              />
            ) : (
              <div className="run-empty">尚未创建 Agent Run</div>
            )}
            <ContextControls
              {...(activeArticleTitle ? { activeArticleTitle } : {})}
              {...(contextError ? { contextError } : {})}
              memories={memories}
              mentionActiveArticle={mentionActiveArticle}
              onMemoryDecision={decideMemory}
              onMentionChange={setMentionActiveArticle}
              onSkillCreate={createSkill}
              onSkillChange={setSelectedSkillKeys}
              selectedSkillKeys={selectedSkillKeys}
              skills={skills}
            />
            <ThreadPrimitive.ViewportFooter className="thread-footer">
              <ThreadPrimitive.ScrollToBottom asChild>
                <button
                  className="scroll-button"
                  aria-label="滚动到底部"
                  title="滚动到底部"
                  type="button"
                >
                  <ArrowDown aria-hidden="true" size={15} />
                </button>
              </ThreadPrimitive.ScrollToBottom>
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
          <AgentComposer
            readiness={readiness.status}
            sendMode={sendMode}
            setSendMode={setSendMode}
          />
        </ThreadPrimitive.Root>
      </aside>
    </AssistantRuntimeProvider>
  );
}

type SkillView = {
  readonly skillId: string;
  readonly version: string;
  readonly description: string;
};
type MemoryView = {
  readonly id: string;
  readonly subject: string;
  readonly value: string;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'superseded';
};

function ContextControls({
  activeArticleTitle,
  contextError,
  memories,
  mentionActiveArticle,
  onMemoryDecision,
  onMentionChange,
  onSkillCreate,
  onSkillChange,
  selectedSkillKeys,
  skills,
}: {
  readonly activeArticleTitle?: string;
  readonly contextError?: string;
  readonly memories: readonly MemoryView[];
  readonly mentionActiveArticle: boolean;
  readonly onMemoryDecision: (id: string, decision: 'accepted' | 'rejected') => Promise<void>;
  readonly onMentionChange: (value: boolean) => void;
  readonly onSkillCreate: (markdown: string) => Promise<boolean>;
  readonly onSkillChange: (keys: readonly string[]) => void;
  readonly selectedSkillKeys: readonly string[];
  readonly skills: readonly SkillView[];
}): React.JSX.Element {
  const pending = memories.filter(({ status }) => status === 'pending');
  const [skillEditorOpen, setSkillEditorOpen] = useState(false);
  const [skillMarkdown, setSkillMarkdown] = useState('');
  return (
    <section className="context-controls" aria-label="Agent 上下文">
      <strong>上下文</strong>
      {activeArticleTitle ? (
        <label>
          <input
            checked={mentionActiveArticle}
            onChange={(event) => {
              onMentionChange(event.target.checked);
            }}
            type="checkbox"
          />
          @{activeArticleTitle}
        </label>
      ) : null}
      {skills.map((skill) => {
        const key = `${skill.skillId}@${skill.version}`;
        return (
          <label key={key} title={skill.description}>
            <input
              checked={selectedSkillKeys.includes(key)}
              onChange={(event) => {
                onSkillChange(
                  event.target.checked
                    ? [...selectedSkillKeys, key]
                    : selectedSkillKeys.filter((item) => item !== key),
                );
              }}
              type="checkbox"
            />
            /{skill.skillId} · {skill.version}
          </label>
        );
      })}
      <button
        className="context-secondary-action"
        onClick={() => {
          setSkillEditorOpen((current) => !current);
        }}
        type="button"
      >
        {skillEditorOpen ? '取消新建 Skill' : '新建 Skill'}
      </button>
      {skillEditorOpen ? (
        <div className="skill-editor">
          <textarea
            aria-label="Skill Markdown"
            onChange={(event) => {
              setSkillMarkdown(event.target.value);
            }}
            placeholder="---&#10;id: news&#10;version: 1.0.0&#10;description: 新闻写作&#10;allowedTools: []&#10;---&#10;写作规则"
            rows={8}
            value={skillMarkdown}
          />
          <button
            disabled={!skillMarkdown.trim()}
            onClick={() => {
              void onSkillCreate(skillMarkdown).then((created) => {
                if (!created) return;
                setSkillMarkdown('');
                setSkillEditorOpen(false);
              });
            }}
            type="button"
          >
            保存 Skill
          </button>
        </div>
      ) : null}
      {pending.map((memory) => (
        <div className="memory-candidate" key={memory.id}>
          <span>{memory.subject}：{memory.value}</span>
          <button onClick={() => void onMemoryDecision(memory.id, 'accepted')} type="button">接受</button>
          <button onClick={() => void onMemoryDecision(memory.id, 'rejected')} type="button">拒绝</button>
        </div>
      ))}
      {contextError ? <p role="alert">{contextError}</p> : null}
    </section>
  );
}

function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="aui-message aui-user-message">
      <MessagePrimitive.Parts components={{ Text: MessageText }} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="aui-message aui-assistant-message">
      <div className="assistant-avatar" aria-hidden="true">
        <Sparkles size={13} />
      </div>
      <MessagePrimitive.Parts components={{ Text: MessageText }} />
    </MessagePrimitive.Root>
  );
}

function MessageText(): React.JSX.Element {
  return <MessagePartPrimitive.Text className="message-text" smooth />;
}

function AgentComposer({
  readiness,
  sendMode,
  setSendMode,
}: {
  readonly readiness: 'checking' | 'ready' | 'unavailable';
  readonly sendMode: 'steering' | 'follow-up';
  readonly setSendMode: (mode: 'steering' | 'follow-up') => void;
}): React.JSX.Element {
  const running = useAuiState((state) => state.thread.isRunning);
  return (
    <ComposerPrimitive.Root className="agent-composer">
      <ComposerPrimitive.Input
        aria-label="发送消息给 Agent"
        placeholder={
          readiness === 'ready'
            ? '向 Agent 发送消息...'
            : readiness === 'checking'
              ? '正在检查运行时...'
              : '请先配置 Agent 运行时'
        }
        rows={2}
      />
      <div className="composer-actions">
        <div>
          <div className="send-mode" aria-label="消息模式" role="group">
            <button
              className={sendMode === 'steering' ? 'is-active' : ''}
              onClick={() => {
                setSendMode('steering');
              }}
              type="button"
            >
              引导
            </button>
            <button
              className={sendMode === 'follow-up' ? 'is-active' : ''}
              onClick={() => {
                setSendMode('follow-up');
              }}
              type="button"
            >
              后续
            </button>
          </div>
        </div>
        {running ? (
          <ComposerPrimitive.Cancel asChild>
            <button aria-label="停止运行" className="send-button" title="停止" type="button">
              <Square aria-hidden="true" size={13} />
            </button>
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send asChild>
            <button aria-label="发送" className="send-button" title="发送" type="submit">
              <ArrowUp aria-hidden="true" size={17} />
            </button>
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}

function RunInspector({
  run,
  onToolDecision,
  onProposalDecision,
  onArticleUpdated,
}: {
  readonly run: typeof initialRunView;
  readonly onToolDecision: (toolCallId: string, decision: 'approved' | 'denied') => Promise<void>;
  readonly onProposalDecision: (
    proposalId: string,
    decisions: Readonly<Record<string, 'accepted' | 'rejected'>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly onArticleUpdated?: () => Promise<void>;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const [toolDecisions, setToolDecisions] = useState<Record<string, 'approved' | 'denied'>>({});
  const [proposalDecisions, setProposalDecisions] = useState<
    Record<string, 'accepted' | 'rejected'>
  >({});
  const approval = run.tools.find((tool) => tool.status === 'approval_requested');
  const groupedSpecialists = useMemo(
    () => [...new Set(run.tasks.map((task) => task.owner))],
    [run.tasks],
  );
  const proposal = run.proposal;
  const allProposalOperationsDecided =
    proposal?.operations.every((operation) => proposalDecisions[operation.operationId]) ?? false;
  const proposalSettled =
    proposal?.status === 'accepted' ||
    proposal?.status === 'partially_accepted' ||
    proposal?.status === 'rejected';

  useEffect(() => {
    setProposalDecisions({});
  }, [proposal?.proposalId]);

  const decideAll = (decision: 'accepted' | 'rejected'): void => {
    if (!proposal) return;
    setProposalDecisions(
      Object.fromEntries(proposal.operations.map((operation) => [operation.operationId, decision])),
    );
  };

  const submitProposal = async (): Promise<void> => {
    if (!proposal || !allProposalOperationsDecided || proposalSettled) return;
    try {
      await onProposalDecision(proposal.proposalId, proposalDecisions);
      await onArticleUpdated?.();
    } catch {
      // The runtime and workspace owner expose the persisted error state to the user.
    }
  };

  return (
    <section className="run-inspector" aria-label="Agent 运行详情">
      <button
        aria-expanded={expanded}
        aria-label={expanded ? '折叠运行详情' : '展开运行详情'}
        className="inspector-heading"
        onClick={() => {
          setExpanded((value) => !value);
        }}
        type="button"
      >
        <span>
          <Sparkles aria-hidden="true" size={15} /> 执行计划 · v{run.revision}
        </span>
        <ChevronDown aria-hidden="true" className={expanded ? 'is-open' : ''} size={15} />
      </button>
      {expanded ? (
        <div className="inspector-body">
          <ol className="task-list">
            {run.tasks.map((task) => (
              <li key={task.id}>
                <span className={`task-state task-${task.status}`}>
                  {task.status === 'succeeded' ? <Check size={11} /> : null}
                </span>
                <span>
                  <strong>{task.label}</strong>
                  <small>
                    {task.owner} · {task.criticality === 'required' ? '必需' : '可选'}
                  </small>
                </span>
              </li>
            ))}
          </ol>
          <div className="specialist-row" aria-label="协作 Specialist">
            {groupedSpecialists.map((owner) => (
              <span key={owner}>{owner}</span>
            ))}
          </div>

          <section className="inspector-section">
            <h3>
              <Wrench aria-hidden="true" size={14} /> 工具调用
            </h3>
            {run.tools.map((tool) => (
              <div className="tool-row" key={tool.id}>
                <span>
                  <strong>{tool.name}</strong>
                  <small>{tool.status}</small>
                </span>
                <code>{compactJson(tool.args)}</code>
              </div>
            ))}
          </section>

          {approval ? (
            <section className="approval-row" aria-label="工具审批">
              <CircleAlert aria-hidden="true" size={16} />
              <div>
                <strong>写入前需要审批</strong>
                <span>参数已绑定到本次 Tool Call</span>
              </div>
              <div>
                <button
                  aria-label="批准工具调用"
                  aria-pressed={toolDecisions[approval.id] === 'approved'}
                  className={toolDecisions[approval.id] === 'approved' ? 'is-selected' : ''}
                  onClick={() => {
                    setToolDecisions((value) => ({ ...value, [approval.id]: 'approved' }));
                    void onToolDecision(approval.id, 'approved');
                  }}
                  title="批准"
                  type="button"
                >
                  <Check size={14} />
                </button>
                <button
                  aria-label="拒绝工具调用"
                  aria-pressed={toolDecisions[approval.id] === 'denied'}
                  className={toolDecisions[approval.id] === 'denied' ? 'is-selected' : ''}
                  onClick={() => {
                    setToolDecisions((value) => ({ ...value, [approval.id]: 'denied' }));
                    void onToolDecision(approval.id, 'denied');
                  }}
                  title="拒绝"
                  type="button"
                >
                  <X size={14} />
                </button>
              </div>
            </section>
          ) : null}

          {proposal ? (
            <section className="proposal-preview" aria-label="文章修改提案审核">
              <div className="proposal-heading">
                <div>
                  <strong>文章修改提案</strong>
                  <span>{proposal.operations.length} 项修改</span>
                </div>
                {!proposalSettled ? (
                  <div>
                    <button
                      disabled={proposal.status === 'submitting'}
                      onClick={() => {
                        decideAll('accepted');
                      }}
                      type="button"
                    >
                      全部接受
                    </button>
                    <button
                      disabled={proposal.status === 'submitting'}
                      onClick={() => {
                        decideAll('rejected');
                      }}
                      type="button"
                    >
                      全部拒绝
                    </button>
                  </div>
                ) : null}
              </div>
              <ArticleDiff
                decisions={proposalDecisions}
                disabled={proposal.status === 'submitting' || proposalSettled}
                entries={proposal.diffs}
                onDecision={(operationId, decision) => {
                  setProposalDecisions((current) => ({ ...current, [operationId]: decision }));
                }}
              />
              {proposal.error ? (
                <p className="proposal-error" role="alert">
                  {proposal.error}
                </p>
              ) : null}
              <div className="proposal-submit-row">
                <span>{proposalStatusText(proposal.status)}</span>
                {!proposalSettled ? (
                  <button
                    className="primary-action"
                    disabled={!allProposalOperationsDecided || proposal.status === 'submitting'}
                    onClick={() => void submitProposal()}
                    type="button"
                  >
                    {proposal.status === 'submitting' ? '提交中...' : '应用决策'}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="inspector-section evidence-list">
            <h3>
              <FileCheck2 aria-hidden="true" size={14} /> Evidence
            </h3>
            {run.evidence.map((item) => (
              <div key={item.evidenceId}>
                <strong>{item.title}</strong>
                <span title={item.revision}>{item.source}</span>
              </div>
            ))}
          </section>

          <footer className="run-metadata">
            <span>
              <Coins aria-hidden="true" size={13} />{' '}
              {run.usage.inputTokens + run.usage.outputTokens} tokens · $
              {run.usage.costUsd.toFixed(3)}
            </span>
            <span>
              <RotateCcw aria-hidden="true" size={13} /> {run.recovery}
            </span>
          </footer>
        </div>
      ) : null}
    </section>
  );
}

function proposalStatusText(status: NonNullable<typeof initialRunView.proposal>['status']): string {
  if (status === 'submitting') return '正在写入不可变文章修订';
  if (status === 'accepted') return '已接受全部修改';
  if (status === 'partially_accepted') return '已应用部分修改';
  if (status === 'rejected') return '已拒绝全部修改';
  if (status === 'error') return '提交失败，可检查后重试';
  return '请逐项审核后提交';
}

function compactJson(value: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(value);
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}
function statusTone(status: string): string {
  if (status.includes('失败') || status.includes('取消')) return 'danger';
  if (status.includes('审批') || status.includes('重连')) return 'warning';
  if (status.includes('完成')) return 'success';
  return 'active';
}

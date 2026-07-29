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
  AtSign,
  Check,
  ChevronDown,
  CircleAlert,
  Coins,
  FileCheck2,
  MoreHorizontal,
  Paperclip,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { DiffEntry } from '@agentpress/editor-patch';

import {
  useAgentPressAssistantRuntime,
  type AgentSendMode,
} from '../lib/agentpress-assistant-runtime';
import { initialRunView } from '../lib/run-event-reducer';
import { ArticleDiff } from './article-diff';

export function AgentWorkbench(): React.JSX.Element {
  const [sendMode, setSendMode] = useState<AgentSendMode>('steering');
  const { runtime, run, decideTool } = useAgentPressAssistantRuntime(sendMode);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <aside className="agent-panel" aria-label="Agent 工作台">
        <header className="agent-header">
          <div>
            <strong>写作助手</strong>
            <span className={`status-dot status-${statusTone(run.status)}`}>{run.status}</span>
          </div>
          <button aria-label="Agent 菜单" className="icon-button" title="Agent 菜单" type="button">
            <MoreHorizontal aria-hidden="true" size={18} />
          </button>
        </header>

        <ThreadPrimitive.Root className="aui-thread">
          <ThreadPrimitive.Viewport className="agent-thread">
            <ThreadPrimitive.Messages>
              {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
            </ThreadPrimitive.Messages>
            <RunInspector onToolDecision={decideTool} run={run} />
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
          <AgentComposer sendMode={sendMode} setSendMode={setSendMode} />
        </ThreadPrimitive.Root>
      </aside>
    </AssistantRuntimeProvider>
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
  sendMode,
  setSendMode,
}: {
  readonly sendMode: 'steering' | 'follow-up';
  readonly setSendMode: (mode: 'steering' | 'follow-up') => void;
}): React.JSX.Element {
  const running = useAuiState((state) => state.thread.isRunning);
  const [mentionActive, setMentionActive] = useState(true);
  const [skillActive, setSkillActive] = useState(true);
  return (
    <ComposerPrimitive.Root className="agent-composer">
      <div className="composer-context">
        {mentionActive ? (
          <span>
            <AtSign aria-hidden="true" size={13} /> 当前文章 · rev-18
          </span>
        ) : null}
        {skillActive ? (
          <span>
            <ShieldCheck aria-hidden="true" size={13} /> 事实核验
          </span>
        ) : null}
      </div>
      <ComposerPrimitive.Input
        aria-label="发送消息给 Agent"
        placeholder="向 Agent 发送消息..."
        rows={2}
      />
      <div className="composer-actions">
        <div>
          <button aria-label="添加附件" className="icon-button" title="添加附件" type="button">
            <Paperclip aria-hidden="true" size={17} />
          </button>
          <button
            aria-label={mentionActive ? '移除 Mention' : '添加 Mention'}
            className={mentionActive ? 'icon-button is-active' : 'icon-button'}
            onClick={() => {
              setMentionActive((value) => !value);
            }}
            title="Mention"
            type="button"
          >
            <AtSign aria-hidden="true" size={17} />
          </button>
          <button
            aria-label={skillActive ? '移除 Skill' : '添加 Skill'}
            className={skillActive ? 'icon-button is-active' : 'icon-button'}
            onClick={() => {
              setSkillActive((value) => !value);
            }}
            title="Skill"
            type="button"
          >
            <ShieldCheck aria-hidden="true" size={17} />
          </button>
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
}: {
  readonly run: typeof initialRunView;
  readonly onToolDecision: (toolCallId: string, decision: 'approved' | 'denied') => Promise<void>;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const [toolDecisions, setToolDecisions] = useState<Record<string, 'approved' | 'denied'>>({});
  const [diffDecisions, setDiffDecisions] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const approval = run.tools.find((tool) => tool.status === 'approval_requested');
  const groupedSpecialists = useMemo(
    () => [...new Set(run.tasks.map((task) => task.owner))],
    [run.tasks],
  );

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

          <section className="inspector-section evidence-list">
            <h3>
              <FileCheck2 aria-hidden="true" size={14} /> Evidence
            </h3>
            {run.evidence.map((item) => (
              <div key={item.title}>
                <strong>{item.title}</strong>
                <span>{item.source}</span>
              </div>
            ))}
          </section>

          <section className="inspector-section proposal-preview">
            <h3>
              <Sparkles aria-hidden="true" size={14} /> 文章修改提案
            </h3>
            <ArticleDiff
              entries={sampleDiff}
              decisions={diffDecisions}
              onDecision={(id, decision) => {
                setDiffDecisions((value) => ({ ...value, [id]: decision }));
              }}
            />
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

const sampleDiff: readonly DiffEntry[] = [
  {
    operationId: 'edit-intro',
    kind: 'replace',
    blockId: 'lead',
    before: {
      type: 'paragraph',
      attrs: { blockId: 'lead' },
      content: [{ type: 'text', text: '好的写作工具不应该替作者做决定。' }],
    },
    after: {
      type: 'paragraph',
      attrs: { blockId: 'lead' },
      content: [{ type: 'text', text: '可靠的写作 Agent 让每一次研究、修改和引用都可追溯。' }],
    },
  },
];

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

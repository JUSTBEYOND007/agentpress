'use client';

import { ActionBarPrimitive, MessagePrimitive } from '@assistant-ui/react';
import {
  Check,
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  FileCheck2,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import { useState } from 'react';

import {
  activityLabel,
  friendlyFailure,
  parseRunPart,
  proposalFromPart,
  safeExternalUrl,
  statusLabel,
} from './agent-view-model';
import { recordValue, stringValue, type RunPart } from '../lib/agentpress-assistant-runtime';
import { AssistantMarkdownPart, UserTextPart } from './agent-message-content';
import { ExecutionTimelineRenderer } from './agent-execution-timeline';
import { NoticePart } from './agent-notice-part';
import { ReasoningPart } from './agent-reasoning-part';
import { ArtifactPart } from './agent-artifact-drawer';
import { ContextSourcesPart } from './agent-context-sources';
import { AgentArticleChangePart } from './agent-article-change-part';
import { useRunActions } from './agent-run-actions';
import { AgentUsagePart } from './agent-usage-part';
import { AgentProgressPart } from './agent-progress-part';

export function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="aui-message aui-user-message">
      <MessagePrimitive.Parts components={{ Text: UserTextPart }} />
    </MessagePrimitive.Root>
  );
}

export function AssistantMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="aui-message aui-assistant-message">
      <div className="assistant-content">
        <MessagePrimitive.Parts
          components={{
            Text: AssistantMarkdownPart,
            data: {
              by_name: {
                'agentpress-run-part': RunPartRenderer,
                'agentpress-execution-timeline': ExecutionTimelineRenderer,
              },
            },
          }}
        />
        <ActionBarPrimitive.Root className="message-actions" hideWhenRunning>
          <ActionBarPrimitive.Copy aria-label="复制回答" title="复制回答">
            <Copy aria-hidden="true" size={13} />
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload aria-label="创建分支并重新生成" title="重新生成">
            <RefreshCw aria-hidden="true" size={13} />
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function RunPartRenderer({ data }: { readonly data: unknown }): React.JSX.Element | null {
  const part = parseRunPart(data);
  if (!part) return null;
  if (part.type === 'reasoning') return <ReasoningPart part={part} />;
  if (part.type === 'plan') return <PlanPart part={part} />;
  if (part.type === 'action-proposal') return <ActionProposalPart part={part} />;
  if (part.type === 'tool-approval') return <ApprovalPart part={part} />;
  if (part.type === 'ask-user') return <AskUserPart part={part} />;
  if (part.type === 'artifact') return <ArtifactPart part={part} />;
  if (part.type === 'context') return <ContextSourcesPart part={part} />;
  if (part.type === 'evidence') return <EvidencePart part={part} />;
  if (part.type === 'article-change') return <AgentArticleChangePart part={part} />;
  if (part.type === 'usage') return <AgentUsagePart part={part} />;
  if (part.type === 'progress') return <AgentProgressPart part={part} />;
  if (part.type === 'warning' || part.type === 'recovery') return <NoticePart part={part} />;
  if (part.type === 'activity') {
    const proposal = proposalFromPart(part);
    return proposal ? (
      <AgentArticleChangePart part={{ ...part, type: 'article-change' }} />
    ) : (
      <ActivityPart part={part} />
    );
  }
  return null;
}

function ActionProposalPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const actions = useRunActions();
  const proposalId = stringValue(part.payload.id);
  const [decision, setDecision] = useState<'confirmed' | 'rejected' | undefined>(() =>
    part.status === 'action.confirmed'
      ? 'confirmed'
      : part.status === 'action.rejected'
        ? 'rejected'
        : undefined,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const decide = (next: 'confirmed' | 'rejected'): void => {
    if (!proposalId || pending || decision) return;
    setPending(true);
    setError(undefined);
    void actions
      .decideActionProposal(proposalId, next)
      .then(() => {
        setDecision(next);
      })
      .catch((reason: unknown) => {
        setError(friendlyFailure(reason, '动作没有确认成功，请重试。'));
      })
      .finally(() => {
        setPending(false);
      });
  };
  return (
    <section className="run-part action-proposal-part" aria-label="文章动作确认">
      <div>
        <strong>{stringValue(part.payload.summary) || '修改当前文章'}</strong>
        <span>{stringValue(part.payload.instruction)}</span>
      </div>
      <div>
        <button
          aria-label="确认文章修改"
          disabled={pending || Boolean(decision)}
          onClick={() => {
            decide('confirmed');
          }}
          title="确认"
          type="button"
        >
          <Check size={14} />
        </button>
        <button
          aria-label="拒绝文章修改"
          disabled={pending || Boolean(decision)}
          onClick={() => {
            decide('rejected');
          }}
          title="拒绝"
          type="button"
        >
          <X size={14} />
        </button>
      </div>
      {decision ? (
        <p className="interaction-result">{decision === 'confirmed' ? '已确认' : '已拒绝'}</p>
      ) : null}
      {error ? <p className="interaction-error">{error}</p> : null}
    </section>
  );
}

function PlanPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const tasks = Array.isArray(part.payload.tasks) ? part.payload.tasks.map(recordValue) : [];
  const taskCount = tasks.length;
  return (
    <details className="run-part plan-part">
      <summary>
        <ListChecks size={14} />
        <span>{stringValue(part.payload.summary) || '执行计划'}</span>
        <small>{taskCount > 0 ? `${String(taskCount)} 项任务` : '查看计划'}</small>
      </summary>
      <ol>
        {tasks.map((task, index) => (
          <li key={stringValue(task.id) || String(index)}>
            <span className="task-state" />
            <div>
              <strong>{stringValue(task.objective) || stringValue(task.label)}</strong>
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

function ActivityPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const active = part.status.includes('started') || part.status.includes('executing');
  return (
    <div className={`run-part activity-part${active ? ' is-active' : ''}`} role="status">
      {active ? <LoaderCircle className="activity-spinner" size={13} /> : <Clock3 size={13} />}
      <span>{activityLabel(part)}</span>
      <small>{statusLabel(part.status)}</small>
    </div>
  );
}

function ApprovalPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const actions = useRunActions();
  const toolCallId = stringValue(part.payload.toolCallId);
  const [decision, setDecision] = useState<'approved' | 'denied'>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const decide = (next: 'approved' | 'denied'): void => {
    setPending(true);
    setError(undefined);
    void actions
      .decideTool(toolCallId, next)
      .then(() => {
        setDecision(next);
      })
      .catch((reason: unknown) => {
        setError(friendlyFailure(reason, '没有完成确认，请重试。'));
      })
      .finally(() => {
        setPending(false);
      });
  };
  return (
    <section className="run-part approval-row" aria-label="工具审批">
      <CircleAlert size={16} />
      <div>
        <strong>需要你的确认</strong>
        <span>{stringValue(part.payload.sideEffect) || '继续前需要确认这项操作'}</span>
      </div>
      <div>
        <button
          disabled={Boolean(decision) || pending}
          onClick={() => {
            decide('approved');
          }}
          type="button"
        >
          <Check size={14} />
          允许
        </button>
        <button
          disabled={Boolean(decision) || pending}
          onClick={() => {
            decide('denied');
          }}
          type="button"
        >
          <X size={14} />
          拒绝
        </button>
      </div>
      {decision ? (
        <p className="interaction-result">{decision === 'approved' ? '已允许' : '已拒绝'}</p>
      ) : null}
      {error ? <p className="interaction-error">{error}</p> : null}
    </section>
  );
}

function AskUserPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const actions = useRunActions();
  const [answer, setAnswer] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submittedAnswer, setSubmittedAnswer] = useState('');
  const [error, setError] = useState<string>();
  const options = Array.isArray(part.payload.options)
    ? part.payload.options.filter((value): value is string => typeof value === 'string')
    : [];
  const submit = (value: string): void => {
    if (!value.trim() || submitted) return;
    setSubmitted(true);
    setError(undefined);
    void actions
      .answerQuestion(part.runId, stringValue(part.payload.questionId), value)
      .then(() => {
        setSubmittedAnswer(value.trim());
      })
      .catch((reason: unknown) => {
        setSubmitted(false);
        setError(friendlyFailure(reason, '回答没有发送成功，请重试。'));
      });
  };
  return (
    <section className="run-part ask-user-part">
      <strong>{stringValue(part.payload.question) || '需要补充信息'}</strong>
      {submittedAnswer ? (
        <p className="interaction-result">已回答：{submittedAnswer}</p>
      ) : options.length > 0 ? (
        <div>
          {options.map((option) => (
            <button
              disabled={submitted}
              key={option}
              onClick={() => {
                submit(option);
              }}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {!submittedAnswer ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(answer);
          }}
        >
          <input
            aria-label="回答 Agent 的问题"
            disabled={submitted}
            onChange={(event) => {
              setAnswer(event.target.value);
            }}
            value={answer}
          />
          <button disabled={submitted || !answer.trim()} type="submit">
            回答
          </button>
        </form>
      ) : null}
      {error ? <p className="interaction-error">{error}</p> : null}
    </section>
  );
}

function EvidencePart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const href = safeExternalUrl(part.payload.url) ?? safeExternalUrl(part.payload.sourceUrl);
  return (
    <section className="run-part evidence-part">
      <FileCheck2 size={14} />
      {href ? (
        <a href={href} rel="noopener noreferrer" target="_blank">
          {stringValue(part.payload.title) || '查看引用来源'}
          <ExternalLink aria-hidden="true" size={11} />
        </a>
      ) : (
        <strong>{stringValue(part.payload.title) || '引用来源'}</strong>
      )}
      <span>{stringValue(part.payload.source)}</span>
    </section>
  );
}

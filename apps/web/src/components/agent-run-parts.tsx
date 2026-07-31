'use client';

import { MessagePartPrimitive, MessagePrimitive } from '@assistant-ui/react';
import {
  Check,
  CircleAlert,
  Clock3,
  Coins,
  FileCheck2,
  FileText,
  RotateCcw,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { createContext, useContext, useState } from 'react';

import { ArticleDiff } from './article-diff';
import {
  compactJson,
  parseRunPart,
  proposalFromPart,
  statusLabel,
  type Proposal,
} from './agent-view-model';
import {
  numberValue,
  recordValue,
  stringValue,
  type RunPart,
} from '../lib/agentpress-assistant-runtime';

export type RunActions = {
  readonly decideTool: (toolCallId: string, decision: 'approved' | 'denied') => Promise<void>;
  readonly answerQuestion: (runId: string, questionId: string, answer: string) => Promise<void>;
  readonly decideProposal: (
    proposalId: string,
    decisions: Readonly<Record<string, 'accepted' | 'rejected'>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly onArticleUpdated?: () => Promise<void>;
};

export const RunActionsContext = createContext<RunActions | undefined>(undefined);

export function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="aui-message aui-user-message">
      <MessagePrimitive.Parts components={{ Text: MessageText }} />
    </MessagePrimitive.Root>
  );
}

export function AssistantMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="aui-message aui-assistant-message">
      <div className="assistant-avatar" aria-hidden="true">
        <Sparkles size={13} />
      </div>
      <div className="assistant-content">
        <MessagePrimitive.Parts
          components={{
            Text: MessageText,
            data: { by_name: { 'agentpress-run-part': RunPartRenderer } },
          }}
        />
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
    return proposal ? (
      <ArticleChangePart part={part} proposal={proposal} />
    ) : (
      <ActivityPart part={part} />
    );
  }
  return null;
}

function PlanPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const tasks = Array.isArray(part.payload.tasks) ? part.payload.tasks.map(recordValue) : [];
  return (
    <details className="run-part plan-part" open>
      <summary>
        <Sparkles size={14} /> {stringValue(part.payload.summary) || '执行计划'}
        <small>v{numberValue(part.payload.revisionNumber) || 1}</small>
      </summary>
      <ol>
        {tasks.map((task, index) => (
          <li key={stringValue(task.id) || String(index)}>
            <span className="task-state" />
            <div>
              <strong>{stringValue(task.objective) || stringValue(task.label)}</strong>
              <small>
                {stringValue(task.owner) || 'Specialist'} ·{' '}
                {task.criticality === 'optional' ? '可选' : '必需'}
              </small>
            </div>
          </li>
        ))}
      </ol>
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
      <summary>
        {isTool ? <Wrench size={13} /> : <Clock3 size={13} />}
        <span>{title}</span>
        <small>{statusLabel(part.status)}</small>
      </summary>
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
      <CircleAlert size={16} />
      <div>
        <strong>需要你的确认</strong>
        <span>{stringValue(part.payload.sideEffect) || stringValue(part.payload.toolId)}</span>
      </div>
      <div>
        <button
          disabled={Boolean(decision)}
          onClick={() => {
            setDecision('approved');
            void actions.decideTool(toolCallId, 'approved');
          }}
          type="button"
        >
          <Check size={14} />
          允许
        </button>
        <button
          disabled={Boolean(decision)}
          onClick={() => {
            setDecision('denied');
            void actions.decideTool(toolCallId, 'denied');
          }}
          type="button"
        >
          <X size={14} />
          拒绝
        </button>
      </div>
    </section>
  );
}

function AskUserPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const actions = useRunActions();
  const [answer, setAnswer] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const options = Array.isArray(part.payload.options)
    ? part.payload.options.filter((value): value is string => typeof value === 'string')
    : [];
  const submit = (value: string): void => {
    if (!value.trim() || submitted) return;
    setSubmitted(true);
    void actions
      .answerQuestion(part.runId, stringValue(part.payload.questionId), value)
      .catch(() => { setSubmitted(false); });
  };
  return (
    <section className="run-part ask-user-part">
      <strong>{stringValue(part.payload.question) || '需要补充信息'}</strong>
      {options.length > 0 ? (
        <div>
          {options.map((option) => (
            <button disabled={submitted} key={option} onClick={() => { submit(option); }} type="button">
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(answer);
        }}
      >
        <input
          aria-label="回答 Agent 的问题"
          disabled={submitted}
          onChange={(event) => { setAnswer(event.target.value); }}
          value={answer}
        />
        <button disabled={submitted || !answer.trim()} type="submit">
          回答
        </button>
      </form>
    </section>
  );
}

function ArtifactPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const artifacts = Array.isArray(part.payload.artifacts)
    ? part.payload.artifacts.map(recordValue)
    : [part.payload];
  return (
    <section className="run-part artifact-part">
      <h3>
        <FileText size={14} />
        产出
      </h3>
      {artifacts.map((artifact, index) => (
        <div key={stringValue(artifact.id) || stringValue(artifact.artifactId) || String(index)}>
          <strong>
            {stringValue(artifact.title) || stringValue(artifact.type) || '结构化产物'}
          </strong>
          <span>{stringValue(artifact.summary)}</span>
        </div>
      ))}
    </section>
  );
}

function EvidencePart({ part }: { readonly part: RunPart }): React.JSX.Element {
  return (
    <section className="run-part evidence-part">
      <FileCheck2 size={14} />
      <strong>{stringValue(part.payload.title) || '引用来源'}</strong>
      <span>{stringValue(part.payload.source)}</span>
    </section>
  );
}

function ArticleChangePart({
  part,
  proposal = proposalFromPart(part),
}: {
  readonly part: RunPart;
  readonly proposal?: Proposal;
}): React.JSX.Element | null {
  const actions = useRunActions();
  const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const [submitting, setSubmitting] = useState(false);
  if (!proposal) return null;
  const allDecided = proposal.operations.every(({ operationId }) => decisions[operationId]);
  const decideAll = (decision: 'accepted' | 'rejected'): void => {
    setDecisions(
      Object.fromEntries(proposal.operations.map(({ operationId }) => [operationId, decision])),
    );
  };
  return (
    <section className="run-part proposal-preview">
      <div className="proposal-heading">
        <div>
          <strong>文章修改</strong>
          <span>{proposal.operations.length} 项</span>
        </div>
        <div>
          <button onClick={() => { decideAll('accepted'); }} type="button">
            全部接受
          </button>
          <button onClick={() => { decideAll('rejected'); }} type="button">
            全部拒绝
          </button>
        </div>
      </div>
      <ArticleDiff
        decisions={decisions}
        disabled={submitting}
        entries={proposal.diffs}
        onDecision={(operationId, decision) =>
          { setDecisions((current) => ({ ...current, [operationId]: decision })); }
        }
      />
      <div className="proposal-submit-row">
        <span>逐项确认后应用到正文</span>
        <button
          className="primary-action"
          disabled={!allDecided || submitting}
          onClick={() => {
            setSubmitting(true);
            void actions
              .decideProposal(proposal.proposalId, decisions)
              .then(() => actions.onArticleUpdated?.())
              .finally(() => { setSubmitting(false); });
          }}
          type="button"
        >
          {submitting ? '应用中…' : '应用修改'}
        </button>
      </div>
    </section>
  );
}

function NoticePart({ part }: { readonly part: RunPart }): React.JSX.Element {
  return (
    <div className={`run-part notice-part notice-${part.type}`}>
      <RotateCcw size={13} />
      <span>
        {stringValue(part.payload.message) ||
          stringValue(recordValue(part.payload.failure).message) ||
          statusLabel(part.status)}
      </span>
    </div>
  );
}

function UsagePart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const usage = recordValue(part.payload.usage);
  const tokens = numberValue(usage.inputTokens) + numberValue(usage.outputTokens);
  return (
    <details className="run-part usage-part">
      <summary>
        <Coins size={13} />
        已完成 · {tokens.toLocaleString()} tokens
      </summary>
      <pre>{compactJson(part.payload)}</pre>
    </details>
  );
}

function useRunActions(): RunActions {
  const actions = useContext(RunActionsContext);
  if (!actions) throw new Error('Run actions are unavailable');
  return actions;
}

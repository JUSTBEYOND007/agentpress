'use client';

import { ActionBarPrimitive, AuiIf, MessagePrimitive } from '@assistant-ui/react';
import { Copy, RefreshCw } from 'lucide-react';

import { parseRunPart, proposalFromPart } from './agent-view-model';
import { recordValue } from '../lib/agentpress-assistant-runtime';
import { AssistantMarkdownPart, UserTextPart } from './agent-message-content';
import { ExecutionTimelineRenderer } from './agent-execution-timeline';
import { NoticePart } from './agent-notice-part';
import { ReasoningPart } from './agent-reasoning-part';
import { ArtifactPart } from './agent-artifact-drawer';
import { ContextSourcesPart } from './agent-context-sources';
import { AgentArticleChangePart } from './agent-article-change-part';
import { AgentUsagePart } from './agent-usage-part';
import { AgentProgressPart } from './agent-progress-part';
import { PlanPart } from './agent-plan-part';
import { AgentRunProcess, processPart } from './agent-run-process';
import { ActionProposalPart } from './agent-action-proposal-part';
import { ActivityPart } from './agent-activity-part';
import { ApprovalPart } from './agent-approval-part';
import { AskUserPart } from './agent-ask-user-part';
import { EvidencePart } from './agent-evidence-part';

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
                'agentpress-run-process': AgentRunProcess,
                'agentpress-article-outcome': ArticleOutcomeRenderer,
              },
            },
          }}
        />
        <AuiIf
          condition={(state) =>
            state.message.content.some(
              (part) => part.type === 'text' && part.text.trim().length > 0,
            )
          }
        >
          <ActionBarPrimitive.Root className="message-actions" hideWhenRunning>
            <ActionBarPrimitive.Copy aria-label="复制回答" title="复制回答">
              <Copy aria-hidden="true" size={13} />
            </ActionBarPrimitive.Copy>
            <ActionBarPrimitive.Reload aria-label="创建分支并重新生成" title="重新生成">
              <RefreshCw aria-hidden="true" size={13} />
            </ActionBarPrimitive.Reload>
          </ActionBarPrimitive.Root>
        </AuiIf>
      </div>
    </MessagePrimitive.Root>
  );
}

function ArticleOutcomeRenderer({ data }: { readonly data: unknown }): React.JSX.Element | null {
  const part = processPart(data);
  if (part?.type !== 'article-change') return null;
  const record = recordValue(data);
  return <AgentArticleChangePart part={part} process={record.process} />;
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

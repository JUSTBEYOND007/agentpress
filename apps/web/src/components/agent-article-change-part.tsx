'use client';

import { LocateFixed } from 'lucide-react';
import { useState } from 'react';

import { friendlyFailure, proposalFromPart } from './agent-view-model';
import { useRunActions } from './agent-run-actions';
import type { RunPart } from '../lib/agentpress-assistant-runtime';
import { AgentRunProcess, processDuration } from './agent-run-process';

export function AgentArticleChangePart({
  part,
  process,
}: {
  readonly part: RunPart;
  readonly process?: unknown;
}): React.JSX.Element | null {
  const proposal = proposalFromPart(part);
  const { openArticleProposal } = useRunActions();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  if (!proposal) return null;
  const currentRunOperationCount = proposal.batches
    ?.filter((batch) => batch.runId === part.runId && batch.status === 'active')
    .reduce((total, batch) => total + (batch.operationCount ?? 0), 0);
  const outcomeLabel =
    proposal.reviewMode === 'document'
      ? '已生成整篇文章草稿'
      : currentRunOperationCount && currentRunOperationCount !== proposal.operations.length
        ? `本次新增 ${String(currentRunOperationCount)} 处修改，当前共 ${String(proposal.operations.length)} 处待审`
        : `已生成 ${String(proposal.operations.length)} 处修改`;
  const duration = process ? processDuration(process) : '';
  return (
    <section className="run-part proposal-preview">
      <div className="proposal-heading">
        <div>
          <strong>{outcomeLabel}</strong>
          {duration ? <span>共 {duration}</span> : null}
        </div>
        <span className="proposal-view-status">{proposalStatusLabel(proposal.status)}</span>
      </div>
      {openArticleProposal ? (
        <button
          className="proposal-open-review"
          disabled={opening}
          onClick={() => {
            setOpening(true);
            setError(undefined);
            void openArticleProposal(proposal)
              .catch((reason: unknown) => {
                setError(friendlyFailure(reason, '正文工作草稿加载失败，请重试。'));
              })
              .finally(() => {
                setOpening(false);
              });
          }}
          type="button"
        >
          <LocateFixed aria-hidden="true" size={13} />
          {opening ? '正在打开' : '在正文中审阅'}
        </button>
      ) : null}
      {error ? <p className="interaction-error">{error}</p> : null}
      {process ? <AgentRunProcess data={process} /> : null}
    </section>
  );
}

function proposalStatusLabel(status: ProposalStatus): string {
  const labels: Record<ProposalStatus, string> = {
    pending: '正文工作草稿',
    partially_accepted: '部分已接受',
    accepted: '已接受',
    rejected: '已拒绝',
    expired: '已失效',
  };
  return labels[status];
}

type ProposalStatus = NonNullable<ReturnType<typeof proposalFromPart>>['status'];

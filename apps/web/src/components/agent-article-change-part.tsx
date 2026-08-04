'use client';

import { LocateFixed } from 'lucide-react';
import { useState } from 'react';

import { friendlyFailure, proposalFromPart } from './agent-view-model';
import { useRunActions } from './agent-run-actions';
import type { RunPart } from '../lib/agentpress-assistant-runtime';

export function AgentArticleChangePart({
  part,
}: {
  readonly part: RunPart;
}): React.JSX.Element | null {
  const proposal = proposalFromPart(part);
  const { openArticleProposal } = useRunActions();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  if (!proposal) return null;
  return (
    <section className="run-part proposal-preview">
      <div className="proposal-heading">
        <div>
          <strong>文章修改</strong>
          <span>
            {proposal.reviewMode === 'document'
              ? '整篇文章草稿'
              : `${String(proposal.operations.length)} 处修改`}
          </span>
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

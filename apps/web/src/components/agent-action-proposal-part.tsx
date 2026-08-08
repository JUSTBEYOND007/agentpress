'use client';

import { Check, X } from 'lucide-react';
import { useState } from 'react';

import { stringValue, type RunPart } from '../lib/agentpress-assistant-runtime';
import { useRunActions } from './agent-run-actions';
import { friendlyFailure } from './agent-view-model';

export function ActionProposalPart({ part }: { readonly part: RunPart }): React.JSX.Element {
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

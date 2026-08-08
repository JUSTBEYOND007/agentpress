'use client';

import { Check, CircleAlert, X } from 'lucide-react';
import { useState } from 'react';

import { stringValue, type RunPart } from '../lib/agentpress-assistant-runtime';
import { useRunActions } from './agent-run-actions';
import { friendlyFailure } from './agent-view-model';

export function ApprovalPart({ part }: { readonly part: RunPart }): React.JSX.Element {
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

'use client';

import { Brain, LoaderCircle } from 'lucide-react';

import { numberValue, type RunPart } from '../lib/agentpress-assistant-runtime';

export function ReasoningPart({
  part,
  embedded = false,
}: {
  readonly part: RunPart;
  readonly embedded?: boolean;
}): React.JSX.Element {
  const active = part.status === 'run.planning';
  const durationMs = numberValue(part.payload.durationMs);
  if (embedded) {
    return (
      <div className="run-process-row reasoning-part is-embedded">
        {active ? (
          <LoaderCircle className="activity-spinner" aria-hidden="true" size={13} />
        ) : (
          <Brain aria-hidden="true" size={13} />
        )}
        <span>
          {active
            ? '正在思考'
            : durationMs > 0
              ? `思考了 ${formatDuration(durationMs)}`
              : '思考过程'}
        </span>
      </div>
    );
  }
  return (
    <div className={`run-part reasoning-part${active ? ' is-active' : ''}`} role="status">
      <div className="reasoning-summary">
        {active ? (
          <LoaderCircle className="activity-spinner" aria-hidden="true" size={13} />
        ) : (
          <Brain aria-hidden="true" size={13} />
        )}
        <span>
          {active
            ? '正在思考'
            : durationMs > 0
              ? `思考了 ${formatDuration(durationMs)}`
              : '思考过程'}
        </span>
      </div>
    </div>
  );
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return '<1 秒';
  if (durationMs < 60_000) return `${String(Math.round(durationMs / 1_000))} 秒`;
  return `${String(Math.floor(durationMs / 60_000))} 分 ${String(
    Math.round((durationMs % 60_000) / 1_000),
  )} 秒`;
}

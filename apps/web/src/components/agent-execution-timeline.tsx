'use client';

import { Check, ChevronDown, CircleAlert, Clock3, LoaderCircle, X } from 'lucide-react';

import { numberValue, type RunPart } from '../lib/agentpress-assistant-runtime';
import { activityLabel, parseRunPart, statusLabel } from './agent-view-model';
import { runVisualState, type RunVisualState } from './agent-run-state';

export type ExecutionTimelineData = { readonly steps: readonly unknown[] };

export function ExecutionTimelineRenderer({
  data,
}: {
  readonly data: unknown;
}): React.JSX.Element | null {
  const record = typeof data === 'object' && data !== null ? (data as ExecutionTimelineData) : null;
  const steps = Array.isArray(record?.steps)
    ? record.steps.flatMap((step) => {
        const parsed = parseRunPart(step);
        return parsed?.type === 'activity' ? [parsed] : [];
      })
    : [];
  if (steps.length === 0) return null;
  const active = steps.some((step) => ['active', 'waiting'].includes(runVisualState(step.status)));
  return (
    <details className="run-part execution-timeline" open={active}>
      <summary>
        <TimelineIcon state={timelineState(steps)} />
        <strong>执行步骤</strong>
        <small>{timelineSummary(steps)}</small>
        <ChevronDown className="timeline-chevron" aria-hidden="true" size={13} />
      </summary>
      <ol>
        {steps.map((step) => (
          <ExecutionStep key={step.id} step={step} />
        ))}
      </ol>
    </details>
  );
}

function ExecutionStep({ step }: { readonly step: RunPart }): React.JSX.Element {
  const state = runVisualState(step.status);
  const durationMs = numberValue(step.payload.durationMs);
  return (
    <li className={`execution-step is-${state}`}>
      <TimelineIcon state={state} />
      <div>
        <span>{activityLabel(step)}</span>
        <small>
          {statusLabel(step.status)}
          {durationMs > 0 ? ` · ${formatStepDuration(durationMs)}` : ''}
        </small>
      </div>
    </li>
  );
}

function TimelineIcon({ state }: { readonly state: RunVisualState }): React.JSX.Element {
  if (state === 'active') return <LoaderCircle className="activity-spinner" size={13} />;
  if (state === 'succeeded') return <Check size={13} />;
  if (state === 'failed' || state === 'cancelled' || state === 'stale') return <X size={13} />;
  if (state === 'waiting' || state === 'degraded') return <CircleAlert size={13} />;
  return <Clock3 size={13} />;
}

function timelineState(steps: readonly RunPart[]): RunVisualState {
  const states = steps.map(({ status }) => runVisualState(status));
  for (const state of ['failed', 'stale', 'waiting', 'active', 'degraded'] as const) {
    if (states.includes(state)) return state;
  }
  return states.every((state) => state === 'succeeded') ? 'succeeded' : 'queued';
}

function timelineSummary(steps: readonly RunPart[]): string {
  const completed = steps.filter(({ status }) => runVisualState(status) === 'succeeded').length;
  return `${String(completed)}/${String(steps.length)} 已完成`;
}

export function formatStepDuration(durationMs: number): string {
  return durationMs < 1_000 ? '<1 秒' : `${String(Math.max(1, Math.round(durationMs / 1_000)))} 秒`;
}

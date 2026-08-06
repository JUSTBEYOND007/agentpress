'use client';

import { Check, ChevronDown, CircleAlert, LoaderCircle } from 'lucide-react';

import { numberValue, recordValue, stringValue } from '../lib/agentpress-assistant-runtime';
import type { RunPart, RunProcessPresentation } from '../lib/agent-runtime-contracts';
import { ContextSourcesPart } from './agent-context-sources';
import { ExecutionTimelineRenderer } from './agent-execution-timeline';
import { AgentProgressPart } from './agent-progress-part';
import { PlanPart } from './agent-plan-part';
import { ReasoningPart } from './agent-reasoning-part';
import { AgentUsagePart } from './agent-usage-part';
import { activityLabel, parseRunPart, statusLabel } from './agent-view-model';

export function AgentRunProcess({ data }: { readonly data: unknown }): React.JSX.Element | null {
  const process = parseProcessPresentation(data);
  if (!process || process.parts.length === 0) return null;
  const view = processSummary(process);
  const contexts = process.parts.filter(({ type }) => type === 'context');
  const reasoning = process.parts.filter(({ type }) => type === 'reasoning');
  const plans = process.parts.filter(({ type }) => type === 'plan');
  const progress = process.parts.filter(({ type }) => type === 'progress');
  const activities = process.parts.filter(({ type }) => type === 'activity');
  const usage = process.parts.filter(({ type }) => type === 'usage');

  return (
    <details className={`run-process-details is-${view.state}`}>
      <summary>
        {view.state === 'active' ? (
          <LoaderCircle className="activity-spinner" aria-hidden="true" size={13} />
        ) : view.state === 'warning' ? (
          <CircleAlert aria-hidden="true" size={13} />
        ) : (
          <Check aria-hidden="true" size={13} />
        )}
        <span role="status">{view.label}</span>
        {view.meta ? <small>{view.meta}</small> : null}
        <ChevronDown className="run-process-chevron" aria-hidden="true" size={13} />
      </summary>
      <div className="run-process-body">
        {contexts.map((part) => (
          <ContextSourcesPart embedded key={part.id} part={part} />
        ))}
        {reasoning.map((part) => (
          <ReasoningPart embedded key={part.id} part={part} />
        ))}
        {plans.map((part) => (
          <PlanPart embedded key={part.id} part={part} />
        ))}
        {progress.map((part) => (
          <AgentProgressPart key={part.id} part={part} />
        ))}
        {activities.length > 0 ? (
          <ExecutionTimelineRenderer data={{ steps: activities }} embedded />
        ) : null}
        {usage.map((part) => (
          <AgentUsagePart embedded key={part.id} part={part} />
        ))}
      </div>
    </details>
  );
}

export function parseProcessPresentation(data: unknown): RunProcessPresentation | undefined {
  const record = recordValue(data);
  const parts = Array.isArray(record.parts)
    ? record.parts.flatMap((part) => {
        const parsed = parseRunPart(part);
        return parsed ? [parsed] : [];
      })
    : [];
  const runId = stringValue(record.runId);
  const status = stringValue(record.status);
  if (!runId || !status || typeof record.terminal !== 'boolean') return undefined;
  return { runId, status, terminal: record.terminal, parts };
}

export function processSummary(process: RunProcessPresentation) {
  const usage = process.parts.findLast(({ type }) => type === 'usage');
  const durationMs = usage ? numberValue(usage.payload.durationMs) : 0;
  const progress = process.parts.findLast(({ type }) => type === 'progress');
  const latestActivity = process.parts.findLast(({ type }) => type === 'activity');
  const warning =
    process.status.includes('fail') ||
    process.status.includes('cancel') ||
    process.status.includes('degradation');
  const activeObjective = progress
    ? stringValue(recordValue(progress.payload.activeStep).objective)
    : '';
  const label = process.terminal
    ? '过程详情'
    : activeObjective ||
      (latestActivity ? activityLabel(latestActivity) : statusLabel(process.status));
  const completedSteps = progress ? numberValue(progress.payload.completedSteps) : 0;
  const totalSteps = progress ? numberValue(progress.payload.totalSteps) : 0;
  return {
    state: process.terminal ? (warning ? 'warning' : 'succeeded') : 'active',
    label,
    meta:
      durationMs > 0
        ? formatProcessDuration(durationMs)
        : totalSteps > 0
          ? `${String(completedSteps)}/${String(totalSteps)}`
          : '',
  } as const;
}

function formatProcessDuration(durationMs: number): string {
  if (durationMs < 1_000) return '<1 秒';
  if (durationMs < 60_000) return `${String(Math.round(durationMs / 1_000))} 秒`;
  return `${String(Math.round(durationMs / 60_000))} 分钟`;
}

export function processDuration(data: unknown): string {
  const process = parseProcessPresentation(data);
  return process ? processSummary(process).meta : '';
}

export function processPart(data: unknown): RunPart | undefined {
  return parseRunPart(recordValue(data).part);
}

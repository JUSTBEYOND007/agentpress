'use client';

import { Check, ChevronDown, LoaderCircle } from 'lucide-react';

import { numberValue, recordValue, stringValue } from '../lib/agentpress-assistant-runtime';
import type { RunPart, RunProcessPresentation } from '../lib/agent-runtime-contracts';
import { parseRunPart, statusLabel } from './agent-view-model';

const toolLabels: Readonly<Record<string, string>> = {
  'article.read_current': '读取正文',
  'article.propose_edits': '生成修改稿',
  'web.search': '搜索资料',
  'workspace.search': '搜索资料',
  'media.search': '搜索素材',
  'image.generate': '生成配图',
  'media.import_licensed': '导入素材',
};

export function AgentRunProcess({ data }: { readonly data: unknown }): React.JSX.Element | null {
  const process = parseProcessPresentation(data);
  if (!process) return null;
  const view = processSummary(process);
  if (!process.terminal) {
    return (
      <div className="run-process-status">
        <LoaderCircle className="activity-spinner" aria-hidden="true" size={13} />
        <span role="status">{view.label}</span>
        {view.meta ? <small>{view.meta}</small> : null}
      </div>
    );
  }
  const steps = processSteps(process.parts);
  if (steps.length === 0) return null;

  return (
    <details className="run-process-details">
      <summary>
        <span>{view.label}</span>
        <ChevronDown className="run-process-chevron" aria-hidden="true" size={13} />
      </summary>
      <ol className="run-process-steps">
        {steps.map((step) => (
          <li key={step.id}>
            <Check aria-hidden="true" size={12} />
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
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
  return {
    runId,
    status,
    terminal: record.terminal,
    durationMs: numberValue(record.durationMs),
    parts,
  };
}

export function processSummary(process: RunProcessPresentation) {
  const progress = process.parts.findLast(({ type }) => type === 'progress');
  const latestActivity = process.parts.findLast(({ type }) => type === 'activity');
  const activeObjective = progress
    ? stringValue(recordValue(progress.payload.activeStep).objective)
    : '';
  const label = process.terminal
    ? '执行过程'
    : activeObjective ||
      (latestActivity ? activeActivityLabel(latestActivity) : statusLabel(process.status));
  const completedSteps = progress ? numberValue(progress.payload.completedSteps) : 0;
  const totalSteps = progress ? numberValue(progress.payload.totalSteps) : 0;
  return {
    label,
    meta:
      !process.terminal && totalSteps > 0
        ? `${String(completedSteps)}/${String(totalSteps)}`
        : '',
  } as const;
}

function processSteps(parts: readonly RunPart[]): readonly { id: string; label: string }[] {
  const seen = new Set<string>();
  return parts.flatMap((part) => {
    if (part.type !== 'activity' || !part.status.endsWith('.succeeded')) return [];
    const toolId = stringValue(part.payload.toolId);
    const taskId = stringValue(part.payload.taskId);
    const objective = stringValue(part.payload.objective);
    const key = toolId ? `tool:${toolId}` : taskId ? `task:${taskId}` : '';
    const label = toolId ? toolLabels[toolId] : taskId && objective ? objective : '';
    if (!key || !label || seen.has(key)) return [];
    seen.add(key);
    return [{ id: key, label }];
  });
}

function activeActivityLabel(part: RunPart): string {
  const toolId = stringValue(part.payload.toolId);
  const label = toolLabels[toolId];
  if (!label) return statusLabel(part.status);
  if (part.status === 'tool.succeeded') return `${label}完成`;
  if (part.status === 'tool.failed') return `${label}未完成`;
  return `正在${label}`;
}

function formatProcessDuration(durationMs: number): string {
  if (durationMs < 1_000) return '<1 秒';
  if (durationMs < 60_000) return `${String(Math.round(durationMs / 1_000))} 秒`;
  return `${String(Math.round(durationMs / 60_000))} 分钟`;
}

export function processDuration(data: unknown): string {
  const process = parseProcessPresentation(data);
  return process && process.durationMs > 0 ? formatProcessDuration(process.durationMs) : '';
}

export function processPart(data: unknown): RunPart | undefined {
  return parseRunPart(recordValue(data).part);
}

'use client';

import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { numberValue, recordValue, stringValue } from '../lib/agentpress-assistant-runtime';
import type {
  ConsumerExecutionItem,
  RunPart,
  RunProcessPresentation,
} from '../lib/agent-runtime-contracts';
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
      <div className="run-process-live">
        <div className="run-process-status">
          <LoaderCircle className="activity-spinner" aria-hidden="true" size={13} />
          <span role="status">{view.label}</span>
          {view.meta ? <small>{view.meta}</small> : null}
        </div>
        {process.items.length > 0 ? (
          <div className="run-process-items">
            {process.items.map((item) => (
              <ExecutionItemView item={item} key={item.id} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (process.items.length === 0) return null;

  return (
    <div className="run-process-details">
      <div className="run-process-heading">
        <span>{view.label}</span>
        {process.durationMs > 0 ? <small>{formatProcessDuration(process.durationMs)}</small> : null}
      </div>
      <div className="run-process-items">
        {process.items.map((item) => (
          <ExecutionItemView item={item} key={item.id} />
        ))}
      </div>
    </div>
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
    items: Array.isArray(record.items) ? parseExecutionItems(record.items) : legacyItems(parts),
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
      !process.terminal && totalSteps > 0 ? `${String(completedSteps)}/${String(totalSteps)}` : '',
  } as const;
}

function legacyItems(parts: readonly RunPart[]): readonly ConsumerExecutionItem[] {
  return processSteps(parts).map((step) => ({
    kind: 'pipeline',
    id: step.id,
    label: step.label,
    status: 'completed',
    durationMs: 0,
    stages: [{ id: step.id, label: step.label, status: 'completed' }],
    sequence: 0,
  }));
}

function parseExecutionItems(value: unknown): readonly ConsumerExecutionItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ConsumerExecutionItem => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Record<string, unknown>;
    return (
      (candidate.kind === 'pipeline' || candidate.kind === 'utility-group') &&
      typeof candidate.id === 'string'
    );
  });
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

function ExecutionItemView({ item }: { readonly item: ConsumerExecutionItem }): React.JSX.Element {
  const active = item.status === 'running' || item.status === 'processing';
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) {
      setOpen(true);
      return;
    }
    const timer = window.setTimeout(() => {
      setOpen(false);
    }, 500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [active]);
  if (item.kind === 'utility-group') {
    return (
      <details
        className="run-process-utility"
        open={open}
        onToggle={(event) => {
          setOpen(event.currentTarget.open);
        }}
      >
        <summary>
          <span>{item.count} 个文件操作</span>
          <span className={`execution-status is-${item.status}`}>{statusText(item.status)}</span>
        </summary>
        <ul>
          {item.items.map((child) => (
            <li key={child.id}>
              <Check size={12} aria-hidden="true" />
              <span>{child.label}</span>
            </li>
          ))}
        </ul>
      </details>
    );
  }
  return (
    <details
      className="run-process-pipeline"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        {item.status === 'error' ? (
          <CircleAlert size={13} aria-hidden="true" />
        ) : item.status === 'completed' ? (
          <Check size={13} aria-hidden="true" />
        ) : (
          <LoaderCircle className="activity-spinner" size={13} aria-hidden="true" />
        )}
        <span>{item.label}</span>
        {item.durationMs > 0 ? (
          <small className="execution-duration">{formatProcessDuration(item.durationMs)}</small>
        ) : null}
        <span className={`execution-status is-${item.status}`}>{statusText(item.status)}</span>
      </summary>
      {item.result ? <div className="execution-result">{resultSummary(item.result)}</div> : null}
      <ol>
        {item.stages.map((stage) => (
          <li key={stage.id}>
            <span className={`stage-dot is-${stage.status}`} />
            <span>{stage.label}</span>
          </li>
        ))}
      </ol>
      {item.error ? <p className="execution-error">{item.error}</p> : null}
    </details>
  );
}

function statusText(status: ConsumerExecutionItem['status']): string {
  return status === 'completed' ? '已完成' : status === 'error' ? '未完成' : '进行中';
}

function resultSummary(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return stringValue(record.summary) || stringValue(record.title) || '结果已生成';
  }
  return '结果已生成';
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

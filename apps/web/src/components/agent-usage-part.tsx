'use client';

import { Coins } from 'lucide-react';

import {
  numberValue,
  recordValue,
  stringValue,
  type RunPart,
} from '../lib/agentpress-assistant-runtime';

export function AgentUsagePart({
  part,
  embedded = false,
}: {
  readonly part: RunPart;
  readonly embedded?: boolean;
}): React.JSX.Element {
  const view = executionFactsView(part.payload);
  if (embedded) {
    return (
      <section className="run-process-section usage-part is-embedded">
        <h4>
          <Coins aria-hidden="true" size={13} />
          运行详情
        </h4>
        <UsageBody view={view} />
      </section>
    );
  }
  return (
    <details className="run-part usage-part">
      <summary>
        <Coins aria-hidden="true" size={13} />
        运行详情
      </summary>
      <UsageBody view={view} />
    </details>
  );
}

function UsageBody({
  view,
}: {
  readonly view: ReturnType<typeof executionFactsView>;
}): React.JSX.Element {
  return (
    <>
      <div className="usage-summary">
        {view.durationMs >= 0 ? <span>{formatDuration(view.durationMs)}</span> : null}
        {view.hasUsage ? <span>{view.totalTokens.toLocaleString()} tokens</span> : null}
        {view.hasUsage ? <span>{formatUsd(view.costUsd)}</span> : null}
      </div>
      {view.executions.length > 0 ? (
        <ul className="execution-fact-models">
          {view.executions.map((execution, index) => (
            <li
              key={`${execution.purpose}:${execution.provider}:${execution.model}:${String(index)}`}
            >
              <strong>
                {execution.provider} / {execution.model}
              </strong>
              <span>{execution.purpose}</span>
              {execution.contextWindow > 0 ? (
                <small>上下文 {execution.contextWindow.toLocaleString()}</small>
              ) : null}
              {execution.maxOutputTokens > 0 ? (
                <small>输出上限 {execution.maxOutputTokens.toLocaleString()}</small>
              ) : null}
              {execution.fallbackUsed ? <small>已使用备用模型</small> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {view.hasUsage ? (
        <div className="usage-token-details">
          <span>输入 {view.inputTokens.toLocaleString()}</span>
          <span>输出 {view.outputTokens.toLocaleString()}</span>
          {view.cacheReadTokens > 0 ? (
            <span>缓存读取 {view.cacheReadTokens.toLocaleString()}</span>
          ) : null}
          {view.cacheWriteTokens > 0 ? (
            <span>缓存写入 {view.cacheWriteTokens.toLocaleString()}</span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function executionFactsView(payload: Readonly<Record<string, unknown>>) {
  const usage = recordValue(payload.usage);
  const executions = Array.isArray(payload.executions)
    ? payload.executions.map(recordValue).map((execution) => ({
        purpose: stringValue(execution.purpose),
        provider: stringValue(execution.provider) || 'unknown',
        model: stringValue(execution.model) || 'unknown',
        contextWindow: numberValue(execution.contextWindow),
        maxOutputTokens: numberValue(execution.maxOutputTokens),
        fallbackUsed: execution.fallbackUsed === true,
      }))
    : [];
  return {
    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : -1,
    hasUsage: Object.keys(usage).length > 0,
    inputTokens: numberValue(usage.inputTokens),
    outputTokens: numberValue(usage.outputTokens),
    cacheReadTokens: numberValue(usage.cacheReadTokens),
    cacheWriteTokens: numberValue(usage.cacheWriteTokens),
    totalTokens: numberValue(usage.totalTokens),
    costUsd: numberValue(usage.costUsd),
    executions,
  };
}

function formatDuration(durationMs: number): string {
  if (durationMs < 60_000) return `${String(Math.max(1, Math.round(durationMs / 1000)))} 秒`;
  return `${String(Math.round(durationMs / 60_000))} 分钟`;
}

function formatUsd(costUsd: number): string {
  return `US$${costUsd.toLocaleString('en-US', {
    minimumFractionDigits: costUsd === 0 ? 2 : 4,
    maximumFractionDigits: 6,
  })}`;
}

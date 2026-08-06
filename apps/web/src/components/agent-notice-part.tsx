'use client';

import { ActionBarPrimitive } from '@assistant-ui/react';
import { AlertTriangle, CircleX, RefreshCw, RotateCcw, ShieldAlert } from 'lucide-react';

import { recordValue, stringValue, type RunPart } from '../lib/agentpress-assistant-runtime';
import { friendlyFailure } from './agent-view-model';
import { runVisualState } from './agent-run-state';

export function NoticePart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const state = runVisualState(part.status);
  const error = recordValue(part.payload.error);
  const code = stringValue(error.code) || stringValue(part.payload.code);
  const message = noticeMessage(part, code, error);
  const action = recoveryAction(part, code, error);
  const Icon = state === 'waiting' ? ShieldAlert : state === 'failed' ? CircleX : AlertTriangle;
  return (
    <div className={`run-part notice-part notice-${state}`} role="status">
      {part.type === 'recovery' ? (
        <RotateCcw aria-hidden="true" size={13} />
      ) : (
        <Icon aria-hidden="true" size={13} />
      )}
      <span>{message}</span>
      {action ? (
        <ActionBarPrimitive.Root className="notice-actions" hideWhenRunning={false}>
          <ActionBarPrimitive.Reload aria-label={action.label} title={action.label}>
            <RefreshCw aria-hidden="true" size={12} />
            {action.label}
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      ) : null}
    </div>
  );
}

export function recoveryAction(
  part: RunPart,
  code: string,
  error: Readonly<Record<string, unknown>> = {},
): { readonly label: string } | undefined {
  if (part.type === 'recovery' || part.payload.pendingDraft === true) return undefined;
  if (error.retryable === false) return undefined;
  if (code === 'stale_revision' || code === 'proposal_expired')
    return { label: '基于最新正文重试' };
  if (part.status === 'run.cancelled') return { label: '重新开始' };
  if (part.status === 'run.completed_with_degradation') return { label: '重新生成完整结果' };
  if (
    part.status === 'run.failed' ||
    code === 'provider_error' ||
    code === 'protocol_error' ||
    code === 'runtime_error'
  )
    return { label: '重试' };
  return undefined;
}

export function noticeMessage(
  part: RunPart,
  code: string,
  error: Readonly<Record<string, unknown>>,
): string {
  if (part.type === 'recovery') return '连接中断，正在恢复当前工作。';
  if (part.payload.pendingDraft === true)
    return '本次运行未完成，但正文修改草稿仍已保留，可以继续审阅。';
  if (part.status === 'run.cancelled') return '本次运行已停止。';
  if (part.status === 'run.completed_with_degradation') return '已完成，但部分步骤出现警告。';
  if (code === 'stale_revision' || code === 'proposal_expired') {
    return '正文已经更新，这次修改未覆盖现有内容。请基于最新正文重新修改。';
  }
  if (code === 'provider_error') return '模型服务暂时不可用，请稍后重试。';
  if (code === 'protocol_error') return '运行结果未通过完整性校验，请重新生成。';
  if (code === 'runtime_error') {
    const publicMessage = friendlyFailure(error.message, '运行服务暂时不可用，请稍后重试。');
    return publicMessage === '运行服务暂时不可用，请稍后重试。'
      ? publicMessage
      : `运行未完成：${publicMessage}`;
  }
  return '这一步没有完成，你可以调整要求后继续。';
}

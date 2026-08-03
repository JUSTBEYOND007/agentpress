'use client';

import { AlertTriangle, CircleX, RotateCcw, ShieldAlert } from 'lucide-react';

import { recordValue, stringValue, type RunPart } from '../lib/agentpress-assistant-runtime';
import { friendlyFailure } from './agent-view-model';
import { runVisualState } from './agent-run-state';

export function NoticePart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const state = runVisualState(part.status);
  const error = recordValue(part.payload.error);
  const code = stringValue(error.code) || stringValue(part.payload.code);
  const message = noticeMessage(part, code, error);
  const Icon = state === 'waiting' ? ShieldAlert : state === 'failed' ? CircleX : AlertTriangle;
  return (
    <div className={`run-part notice-part notice-${state}`} role="status">
      {part.type === 'recovery' ? (
        <RotateCcw aria-hidden="true" size={13} />
      ) : (
        <Icon aria-hidden="true" size={13} />
      )}
      <span>{message}</span>
    </div>
  );
}

export function noticeMessage(
  part: RunPart,
  code: string,
  error: Readonly<Record<string, unknown>>,
): string {
  if (part.type === 'recovery') return '连接中断，正在恢复当前工作。';
  if (part.status === 'run.cancelled') return '本次运行已停止。';
  if (part.status === 'run.completed_with_degradation') return '已完成，但部分步骤出现警告。';
  if (code.includes('stale') || code.includes('expired')) {
    return '正文已经更新，这次修改未覆盖现有内容。请基于最新正文重新修改。';
  }
  if (code === 'provider_error') return '模型服务暂时不可用，请稍后重试。';
  if (code === 'protocol_error') return 'Agent 没有完成本次运行协议，请重新发送。';
  if (code === 'runtime_error') {
    const publicMessage = friendlyFailure(error.message, '运行服务暂时不可用，请稍后重试。');
    return publicMessage === '运行服务暂时不可用，请稍后重试。'
      ? publicMessage
      : `运行未完成：${publicMessage}`;
  }
  return '这一步没有完成，你可以调整要求后继续。';
}

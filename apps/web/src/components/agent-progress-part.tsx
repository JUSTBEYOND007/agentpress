'use client';

import { CheckCircle2, Flag, PauseCircle } from 'lucide-react';

import { numberValue, recordValue, stringValue, type RunPart } from '../lib/agentpress-assistant-runtime';

export function AgentProgressPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const view = progressView(part.payload);
  return (
    <section className="run-part agent-progress-part" aria-label="长任务进度">
      <div className="agent-progress-heading">
        <Flag aria-hidden="true" size={13} />
        <strong>{phaseLabel(view.phase)}</strong>
        {view.totalSteps > 0 ? (
          <span>
            {view.completedSteps}/{view.totalSteps} 已完成
          </span>
        ) : null}
      </div>
      {view.activeObjective ? <p>{view.activeObjective}</p> : null}
      {view.outstandingInteraction ? (
        <div className="agent-progress-waiting">
          <PauseCircle aria-hidden="true" size={12} />
          {interactionLabel(view.outstandingInteraction)}
        </div>
      ) : null}
      {view.recoveryReason ? (
        <div className="agent-recovery-point">
          <CheckCircle2 aria-hidden="true" size={12} />
          最近安全点：{recoveryPointLabel(view.recoveryReason)}
        </div>
      ) : null}
    </section>
  );
}

export function progressView(payload: Readonly<Record<string, unknown>>) {
  const activeStep = recordValue(payload.activeStep);
  const recoveryPoint = recordValue(payload.recoveryPoint);
  return {
    phase: stringValue(payload.phase),
    completedSteps: numberValue(payload.completedSteps),
    totalSteps: numberValue(payload.totalSteps),
    activeObjective: stringValue(activeStep.objective),
    outstandingInteraction: stringValue(payload.outstandingInteraction),
    recoveryReason: stringValue(recoveryPoint.reason),
  };
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    queued: '等待开始',
    planning: '正在规划',
    running: '正在执行',
    waiting_for_user: '等待补充信息',
    waiting_for_approval: '等待操作确认',
    recovering: '正在恢复',
    cancelling: '正在停止',
    completed: '任务已完成',
    completed_with_degradation: '任务已完成，部分步骤有警告',
    failed: '任务未完成',
    cancelled: '任务已停止',
  };
  return labels[phase] ?? '任务进行中';
}

function interactionLabel(type: string): string {
  return type === 'ask-user' ? '需要补充信息后继续' : '需要确认操作后继续';
}

function recoveryPointLabel(reason: string): string {
  const labels: Record<string, string> = {
    task_settled: '已保存的任务结果',
    tool_settled: '已保存的工具结果',
    user_answered: '已保存的用户回答',
    approval_decided: '已保存的审批决定',
    worker_recovery: '恢复前的持久化状态',
    terminal_settled: '运行终态',
  };
  return labels[reason] ?? '已持久化状态';
}

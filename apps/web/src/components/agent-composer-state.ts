import type { AgentSendMode, RunProjection } from '../lib/agentpress-assistant-runtime';

export type ComposerSubmissionKind = 'new_run' | 'steering' | 'follow_up';
export type ComposerTerminationKind = 'stop_generation' | 'cancel_run' | 'cancelling';

export type AgentComposerState = {
  readonly submissionKind: ComposerSubmissionKind;
  readonly submissionLabel: string;
  readonly contextLabel?: string;
  readonly placeholder: string;
  readonly sendDisabledReason?: string;
  readonly termination?: {
    readonly kind: ComposerTerminationKind;
    readonly label: string;
    readonly disabled: boolean;
  };
};

export function composerDraftStorageKey(threadKey: string): string {
  return `agentpress:composer-draft:${threadKey}`;
}

export function deriveAgentComposerState(input: {
  readonly readiness: 'checking' | 'ready' | 'unavailable';
  readonly hasConversation: boolean;
  readonly uploadingAttachments: number;
  readonly activeRun?: Pick<RunProjection, 'mode' | 'status' | 'terminal'>;
  readonly sendMode: AgentSendMode;
}): AgentComposerState {
  const activeRun = input.activeRun?.terminal === false ? input.activeRun : undefined;
  const submissionKind: ComposerSubmissionKind = activeRun
    ? input.sendMode === 'steering'
      ? 'steering'
      : 'follow_up'
    : 'new_run';
  const sendDisabledReason = disabledReason(input);
  const base: AgentComposerState = {
    submissionKind,
    submissionLabel: submissionLabel(submissionKind),
    placeholder: composerPlaceholder(input.readiness, submissionKind, input.uploadingAttachments),
    ...(sendDisabledReason ? { sendDisabledReason } : {}),
  };
  if (!activeRun) return base;

  const cancelling = activeRun.status === 'cancelling';
  const stopGeneration =
    activeRun.mode === 'direct' &&
    ['queued', 'planning', 'running', 'recovering'].includes(activeRun.status);
  return {
    ...base,
    contextLabel: submissionKind === 'steering' ? '补充当前任务' : '完成后继续',
    termination: cancelling
      ? { kind: 'cancelling', label: '正在取消', disabled: true }
      : stopGeneration
        ? { kind: 'stop_generation', label: '停止生成', disabled: false }
        : { kind: 'cancel_run', label: '取消任务', disabled: false },
  };
}

function disabledReason(input: {
  readonly readiness: 'checking' | 'ready' | 'unavailable';
  readonly hasConversation: boolean;
  readonly uploadingAttachments: number;
  readonly activeRun?: Pick<RunProjection, 'status' | 'terminal'>;
}): string | undefined {
  if (input.readiness === 'checking') return 'Agent 正在连接';
  if (input.readiness === 'unavailable') return 'Agent 尚未配置';
  if (!input.hasConversation) return '对话尚未加载';
  if (input.uploadingAttachments > 0) return '附件仍在解析';
  if (input.activeRun?.terminal === false && input.activeRun.status === 'cancelling') {
    return '当前任务正在取消';
  }
  return undefined;
}

function submissionLabel(kind: ComposerSubmissionKind): string {
  if (kind === 'steering') return '调整当前任务';
  if (kind === 'follow_up') return '排队到任务完成后';
  return '发送消息';
}

function composerPlaceholder(
  readiness: 'checking' | 'ready' | 'unavailable',
  kind: ComposerSubmissionKind,
  uploadingAttachments: number,
): string {
  if (uploadingAttachments > 0) return '正在解析附件…';
  if (readiness === 'checking') return '正在连接 Agent…';
  if (readiness === 'unavailable') return '请先配置 Agent Provider';
  if (kind === 'steering') return '补充要求，立即调整当前任务…';
  if (kind === 'follow_up') return '输入任务完成后要继续处理的内容…';
  return '提问，或让 Agent 直接修改正文…';
}

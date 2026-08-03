import type { DiffEntry, EditOperation } from '@agentpress/editor-patch';

import {
  numberValue,
  recordValue,
  stringValue,
  type RunPart,
} from '../lib/agentpress-assistant-runtime';

export type SkillView = {
  readonly skillId: string;
  readonly version: string;
  readonly description: string;
};

export type AttachmentView = { readonly id: string; readonly filename: string };

export type MemoryView = {
  readonly id: string;
  readonly subject: string;
  readonly value: string;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'superseded';
};

export type ConversationView = {
  readonly id: string;
  readonly branchId: string;
  readonly title: string;
  readonly isDefault: boolean;
  readonly archivedAt?: string | null;
};

export type Proposal = {
  readonly proposalId: string;
  readonly status: 'pending';
  readonly articleId?: string;
  readonly baseRevisionId?: string;
  readonly operations: readonly EditOperation[];
  readonly reviewMode?: 'granular' | 'document';
  readonly diffs: readonly DiffEntry[];
  readonly batches?: readonly {
    readonly id: string;
    readonly batchNumber: number;
    readonly status: string;
  }[];
};

export function proposalFromPart(part: RunPart): Proposal | undefined {
  const output = recordValue(part.payload.output);
  const value = Object.keys(output).length > 0 ? output : part.payload;
  const proposalId = stringValue(value.proposalId);
  if (
    !proposalId ||
    stringValue(part.payload.proposalStatus) !== 'pending' ||
    !Array.isArray(value.operations) ||
    !Array.isArray(value.diffs)
  )
    return undefined;
  return {
    proposalId,
    status: 'pending',
    ...(stringValue(value.articleId) ? { articleId: stringValue(value.articleId) } : {}),
    ...(stringValue(value.baseRevisionId)
      ? { baseRevisionId: stringValue(value.baseRevisionId) }
      : {}),
    operations: value.operations as readonly EditOperation[],
    reviewMode: value.reviewMode === 'document' ? 'document' : 'granular',
    diffs: value.diffs as readonly DiffEntry[],
    batches: Array.isArray(value.batches)
      ? (value.batches as NonNullable<Proposal['batches']>)
      : [],
  };
}

export function parseRunPart(value: unknown): RunPart | undefined {
  const candidate = recordValue(value);
  const type = stringValue(candidate.type);
  const allowed: readonly RunPart['type'][] = [
    'text',
    'plan',
    'action-proposal',
    'activity',
    'tool-approval',
    'ask-user',
    'evidence',
    'article-change',
    'artifact',
    'warning',
    'recovery',
    'usage',
  ];
  if (!allowed.includes(type as RunPart['type'])) return undefined;
  return {
    id: stringValue(candidate.id),
    runId: stringValue(candidate.runId),
    sequence: numberValue(candidate.sequence),
    type: type as RunPart['type'],
    status: stringValue(candidate.status),
    payload: recordValue(candidate.payload),
  };
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    ready: '就绪',
    checking: '连接中',
    unavailable: '未配置',
    queued: '排队中',
    planning: '规划中',
    running: '工作中',
    waiting_for_approval: '等待确认',
    waiting_for_user: '等待回答',
    recovering: '恢复中',
    completed: '已完成',
    completed_with_degradation: '已完成（有警告）',
    failed: '失败',
    cancelled: '已取消',
    'run.started': '已开始',
    'run.queued': '排队中',
    'run.planning': '正在理解你的需求',
    'run.running': '正在处理',
    'run.waiting_for_approval': '等待你的确认',
    'run.waiting_for_user': '等待你的回答',
    'run.recovering': '正在恢复连接',
    'run.completed': '已完成',
    'run.completed_with_degradation': '已完成，部分内容需要留意',
    'run.failed': '本次处理未完成',
    'run.cancelled': '已停止',
    'task.started': '进行中',
    'task.succeeded': '已完成',
    'task.failed': '失败',
    'tool.proposed': '准备调用',
    'tool.executing': '执行中',
    'tool.succeeded': '已完成',
    'tool.failed': '失败',
  };
  return labels[status] ?? '正在处理';
}

export function activityLabel(part: RunPart): string {
  const summary = stringValue(part.payload.summary);
  if (summary && !looksInternal(summary)) return summary;
  if (part.status.startsWith('tool.')) {
    if (part.status === 'tool.executing') return '正在使用所需工具';
    if (part.status === 'tool.succeeded') return '所需信息已准备好';
    if (part.status === 'tool.failed') return '这一步未能完成';
    return '正在准备下一步';
  }
  if (part.status.startsWith('task.')) {
    const objective = stringValue(part.payload.objective);
    if (objective && !looksInternal(objective)) return objective;
  }
  return statusLabel(part.status);
}

export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function friendlyFailure(value: unknown, fallback = '操作没有完成，请稍后重试。'): string {
  const message = typeof value === 'string' ? value : stringValue(recordValue(value).message);
  if (!message || looksInternal(message)) return fallback;
  return message;
}

function looksInternal(value: string): boolean {
  return (
    value.includes('{') ||
    value.includes('toolCallId') ||
    value.includes('proposalId') ||
    value.startsWith('run.') ||
    value.startsWith('task.') ||
    value.startsWith('tool.')
  );
}

export function statusTone(status: string): string {
  if (status.includes('fail') || status.includes('cancel') || status === 'unavailable')
    return 'danger';
  if (status.includes('waiting') || status.includes('recover')) return 'warning';
  if (status.includes('complete') || status === 'ready') return 'success';
  return 'active';
}

export function showContextError(setError: (message: string) => void): (error: unknown) => void {
  return (error) => {
    setError(error instanceof Error ? error.message : '操作失败');
  };
}

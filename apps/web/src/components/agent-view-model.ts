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
  readonly operations: readonly EditOperation[];
  readonly diffs: readonly DiffEntry[];
};

export function proposalFromPart(part: RunPart): Proposal | undefined {
  const output = recordValue(part.payload.output);
  const value = Object.keys(output).length > 0 ? output : part.payload;
  const proposalId = stringValue(value.proposalId);
  if (!proposalId || !Array.isArray(value.operations) || !Array.isArray(value.diffs))
    return undefined;
  return {
    proposalId,
    operations: value.operations as readonly EditOperation[],
    diffs: value.diffs as readonly DiffEntry[],
  };
}

export function parseRunPart(value: unknown): RunPart | undefined {
  const candidate = recordValue(value);
  const type = stringValue(candidate.type);
  const allowed: readonly RunPart['type'][] = [
    'text',
    'plan',
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

export function compactJson(value: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1197)}...` : text;
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
    'task.started': '进行中',
    'task.succeeded': '已完成',
    'task.failed': '失败',
    'tool.proposed': '准备调用',
    'tool.executing': '执行中',
    'tool.succeeded': '已完成',
    'tool.failed': '失败',
  };
  return labels[status] ?? status.replaceAll('_', ' ');
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

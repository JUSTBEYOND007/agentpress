import type {
  ConsumerExecutionItem,
  ConsumerExecutionStage,
  ConsumerExecutionStatus,
  RunPart,
} from './agent-runtime-contracts';
import { consumerTaskLabel } from './agent-consumer-labels';

export function processDurationMs(parts: readonly RunPart[]): number {
  const usage = parts.findLast(({ type }) => type === 'usage');
  const durationMs = usage?.payload.durationMs;
  return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
    ? durationMs
    : 0;
}

export function isConsumerHiddenDiagnostic(type: RunPart['type']): boolean {
  return (
    type === 'context' ||
    type === 'reasoning' ||
    type === 'plan' ||
    type === 'progress' ||
    type === 'usage'
  );
}

export function isProcessPart(part: RunPart, terminal: boolean): boolean {
  if (part.type === 'reasoning') return true;
  if (
    part.type === 'context' ||
    part.type === 'plan' ||
    part.type === 'progress' ||
    part.type === 'usage'
  )
    return true;
  if (part.type !== 'activity') return false;
  if (terminal && /\.(started|executing)$/u.test(part.status)) return false;
  return !/\.(failed|cancelled|denied|expired|interrupted)$/u.test(part.status);
}

export function isStaleTerminalActivity(part: RunPart, terminal: boolean): boolean {
  return terminal && part.type === 'activity' && /\.(started|executing)$/u.test(part.status);
}

export function sanitizeProcessPart(part: RunPart): RunPart {
  if (part.type === 'reasoning') {
    return {
      ...part,
      payload: {
        durationMs: part.payload.durationMs,
        eventAt: part.payload.eventAt,
      },
    };
  }
  if (part.type === 'plan') {
    const tasks = Array.isArray(part.payload.tasks)
      ? part.payload.tasks.flatMap((task) => {
          if (typeof task !== 'object' || task === null || Array.isArray(task)) return [];
          const record = task as Record<string, unknown>;
          const id = stringProperty(record, 'id');
          const owner = stringProperty(record, 'owner');
          return id ? [{ id, ...(owner ? { owner } : {}) }] : [];
        })
      : [];
    return { ...part, payload: { summary: part.payload.summary, tasks } };
  }
  if (part.type === 'progress') {
    const activeStep = recordProperty(part.payload, 'activeStep');
    return {
      ...part,
      payload: {
        phase: part.payload.phase,
        completedSteps: part.payload.completedSteps,
        totalSteps: part.payload.totalSteps,
        ...(stringProperty(activeStep, 'owner')
          ? { activeStep: { owner: stringProperty(activeStep, 'owner') } }
          : {}),
        outstandingInteraction: part.payload.outstandingInteraction,
        recoveryPoint: part.payload.recoveryPoint,
      },
    };
  }
  if (part.type === 'activity') {
    const payload = Object.fromEntries(
      Object.entries(part.payload).filter(([key]) => key !== 'objective'),
    );
    return { ...part, payload };
  }
  return part;
}

const utilityTools = new Set([
  'article.read_current',
  'web.search',
  'workspace.search',
  'media.search',
  'workspace.list',
  'workspace.read',
  'workspace.grep',
  'workspace.edit',
]);

const toolLabels: Readonly<Record<string, string>> = {
  'article.read_current': '读取正文',
  'article.propose_edits': '生成修改稿',
  'web.search': '搜索资料',
  'workspace.search': '搜索工作区',
  'media.search': '搜索素材',
  'workspace.list': '浏览文件',
  'workspace.read': '读取文件',
  'workspace.grep': '查找内容',
  'workspace.edit': '编辑文件',
  'image.generate': '生成配图',
  'media.import_licensed': '导入素材',
};

export function executionItems(
  parts: readonly RunPart[],
  allParts: readonly RunPart[],
): readonly ConsumerExecutionItem[] {
  const items: ConsumerExecutionItem[] = [];
  const taskLabels = new Map<string, string>();
  for (const part of allParts) {
    if (part.type !== 'plan') continue;
    const tasks = part.payload.tasks;
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      if (typeof task !== 'object' || task === null || Array.isArray(task)) continue;
      const record = task as Record<string, unknown>;
      const id = stringProperty(record, 'id');
      const owner = stringProperty(record, 'owner');
      if (id && owner) taskLabels.set(id, consumerTaskLabel(owner));
    }
  }
  type MutableUtility = {
    kind: 'utility-group';
    id: string;
    count: number;
    status: ConsumerExecutionStatus;
    items: {
      id: string;
      label: string;
      status: ConsumerExecutionStatus;
      result?: unknown;
      sequence: number;
    }[];
    sequence: number;
  };
  let utility: MutableUtility | undefined;
  const flushUtility = (): void => {
    if (utility) items.push(utility);
    utility = undefined;
  };
  for (const part of parts) {
    if (part.type !== 'activity') continue;
    const toolId = stringProperty(part.payload, 'toolId');
    const taskId = stringProperty(part.payload, 'taskId');
    const key = toolId
      ? `tool:${stringProperty(part.payload, 'toolCallId') ?? part.id}`
      : taskId
        ? `task:${taskId}`
        : undefined;
    if (!key) continue;
    const status = executionStatus(part.status);
    const label = activityDisplayLabel(part, taskLabels);
    const result = recordProperty(part.payload, 'output');
    const error = stringProperty(recordProperty(part.payload, 'failure'), 'message');
    if (toolId && utilityTools.has(toolId)) {
      if (!utility || utility.sequence > part.sequence) {
        utility = {
          kind: 'utility-group',
          id: `utility:${part.id}`,
          count: 0,
          status: 'completed',
          items: [],
          sequence: part.sequence,
        };
      }
      const existing = utility.items.findIndex((item) => item.id === key);
      const item = {
        id: key,
        label,
        status,
        ...(Object.keys(result).length ? { result } : {}),
        sequence: part.sequence,
      };
      utility.items =
        existing >= 0
          ? utility.items.map((current, index) => (index === existing ? item : current))
          : [...utility.items, item];
      utility.count = utility.items.length;
      utility.status = aggregateStatus(utility.items.map((item) => item.status));
      continue;
    }
    flushUtility();
    const existing = items.find((item) => item.kind === 'pipeline' && item.id === key);
    if (existing?.kind === 'pipeline') {
      const stages = lifecycleStagesForPart(part, label);
      const next = {
        ...existing,
        status,
        durationMs: durationForPart(part),
        stages,
        ...(Object.keys(result).length ? { result } : {}),
        ...(error ? { error } : {}),
      };
      items[items.indexOf(existing)] = next;
    } else {
      items.push({
        kind: 'pipeline',
        id: key,
        label,
        status,
        durationMs: durationForPart(part),
        stages: lifecycleStagesForPart(part, label),
        ...(Object.keys(result).length ? { result } : {}),
        ...(error ? { error } : {}),
        sequence: part.sequence,
      });
    }
  }
  flushUtility();
  return items.sort((a, b) => a.sequence - b.sequence);
}

function executionStatus(status: string): ConsumerExecutionStatus {
  if (status.endsWith('.timed_out') || status.endsWith('.timeout') || status === 'task_timeout')
    return 'timed_out';
  if (status.endsWith('.cancelled') || status.endsWith('.canceled')) return 'cancelled';
  if (status.endsWith('.interrupted')) return 'interrupted';
  if (status.endsWith('.stale')) return 'stale';
  if (
    status.endsWith('.failed') ||
    status.endsWith('.denied') ||
    status.endsWith('.expired')
  )
    return 'failed';
  if (status.endsWith('.degraded') || status === 'completed_with_degradation') return 'degraded';
  if (status.endsWith('.succeeded') || status.endsWith('.completed')) return 'completed';
  if (status.endsWith('.executing') || status.endsWith('.started')) return 'processing';
  return 'running';
}

function aggregateStatus(statuses: readonly ConsumerExecutionStatus[]): ConsumerExecutionStatus {
  const terminalFailure: ConsumerExecutionStatus[] = [
    'failed',
    'cancelled',
    'timed_out',
    'interrupted',
    'stale',
  ];
  const failure = terminalFailure.find((status) => statuses.includes(status));
  if (failure) return failure;
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.some((status) => status === 'processing' || status === 'running'))
    return 'processing';
  return 'completed';
}

function durationForPart(part: RunPart): number {
  const started = stringProperty(part.payload, 'lifecycleStartedAt');
  const ended = stringProperty(part.payload, 'eventAt');
  if (!started || !ended) return 0;
  const duration = new Date(ended).getTime() - new Date(started).getTime();
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function lifecycleStagesForPart(part: RunPart, label: string): readonly ConsumerExecutionStage[] {
  const raw = Array.isArray(part.payload.lifecycleStages)
    ? part.payload.lifecycleStages
    : [{ status: part.status, eventAt: part.payload.eventAt }];
  const stages = raw.flatMap((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const status = stringProperty(record, 'status');
    if (!status) return [];
    const explicitLabel = stringProperty(record, 'label');
    return [
      {
        id: `${part.id}:${String(index)}`,
        label: explicitLabel ?? stageLabel(label, status),
        status: executionStatus(status),
      },
    ];
  });
  const meaningful = stages.filter(
    (stage) => stage.label !== label && !genericStageLabels.has(stage.label),
  );
  return meaningful.filter(
    (stage, index) => index === 0 || stage.label !== meaningful[index - 1]?.label,
  );
}

const genericStageLabels = new Set(['已开始', '结果已生成', '未完成']);

function stageLabel(label: string, status: string): string {
  if (status.endsWith('.succeeded') || status.endsWith('.completed')) return '结果已生成';
  if (status.endsWith('.timed_out') || status.endsWith('.timeout') || status === 'task_timeout')
    return '已超时';
  if (status.endsWith('.cancelled') || status.endsWith('.canceled')) return '已取消';
  if (status.endsWith('.interrupted')) return '已中断';
  if (status.endsWith('.stale')) return '已过期';
  if (status.endsWith('.degraded')) return '部分完成';
  if (status.endsWith('.failed') || status.endsWith('.denied') || status.endsWith('.expired'))
    return '未完成';
  if (status.endsWith('.executing') || status.endsWith('.started')) return '已开始';
  return label;
}

function activityDisplayLabel(part: RunPart, taskLabels: ReadonlyMap<string, string>): string {
  const toolId = stringProperty(part.payload, 'toolId');
  if (toolId && toolLabels[toolId]) return toolLabels[toolId];
  const taskId = stringProperty(part.payload, 'taskId');
  const owner = stringProperty(part.payload, 'owner');
  return (
    (owner ? consumerTaskLabel(owner) : undefined) ??
    (taskId ? taskLabels.get(taskId) : undefined) ??
    (part.status.startsWith('task.') ? '执行任务' : '处理请求')
  );
}

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function recordProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const candidate = value[key];
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Readonly<Record<string, unknown>>)
    : {};
}

import type { ThreadMessageLike } from '@assistant-ui/react';

import type { StableAgentMessage } from './agent-thread-snapshot';
import { recordValue, stringValue } from './agent-runtime-api';
import type {
  AgentMessage,
  ArticleOutcomePresentation,
  ConsumerExecutionItem,
  ConsumerExecutionStage,
  ConsumerExecutionStatus,
  RunPart,
  RunProcessPresentation,
  RunProjection,
} from './agent-runtime-contracts';

export function buildRunTurns(
  messages: readonly StableAgentMessage[],
  projections: readonly RunProjection[],
  liveContent: readonly { readonly runId: string; readonly text: string }[],
): readonly AgentMessage[] {
  const byRoot = new Map(projections.map((projection) => [projection.rootMessageId, projection]));
  const liveByRunId = new Map(liveContent.map((content) => [content.runId, content.text]));
  const projectedRunIds = new Set(projections.map(({ runId }) => runId));
  const result: AgentMessage[] = [];
  let skipNextAssistant = false;
  for (const message of messages) {
    if (message.role === 'assistant' && skipNextAssistant) {
      skipNextAssistant = false;
      continue;
    }
    result.push({ id: message.id, role: message.role, text: message.content, status: 'complete' });
    if (message.role !== 'user') continue;
    const projection = byRoot.get(message.id);
    if (!projection) continue;
    const liveText = liveByRunId.get(projection.runId);
    result.push({
      id: `run:${projection.runId}`,
      role: 'assistant',
      projection,
      ...(liveText ? { text: liveText } : {}),
      status: projection.terminal ? 'complete' : 'running',
    });
    skipNextAssistant = projectedRunIds.has(projection.runId);
  }
  return result;
}

export function convertAgentMessage(message: AgentMessage): ThreadMessageLike {
  const projection = message.projection;
  const content = projection
    ? projectionContent(projection, message.text)
    : [{ type: 'text' as const, text: message.text ?? '' }];
  return {
    id: message.id,
    role: message.role,
    content,
    ...(message.role === 'assistant'
      ? {
          status:
            message.status === 'running'
              ? ({ type: 'running' } as const)
              : message.status === 'error'
                ? ({ type: 'incomplete', reason: 'error' } as const)
                : ({ type: 'complete', reason: 'stop' } as const),
        }
      : {}),
  };
}

export function upsertProjection(
  current: readonly RunProjection[],
  projection: RunProjection,
): readonly RunProjection[] {
  return [...current.filter(({ runId }) => runId !== projection.runId), projection].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function projectionContent(
  projection: RunProjection,
  liveText?: string,
): ThreadMessageLike['content'] {
  const parts: (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'data'; readonly name: string; readonly data: unknown }
  )[] = [];
  const projectedParts = augmentedProjectionParts(projection);
  const process: RunProcessPresentation = {
    runId: projection.runId,
    status: projection.status,
    terminal: projection.terminal,
    durationMs: processDurationMs(projectedParts),
    parts: projectedParts.filter(isProcessPart),
    items: executionItems(projectedParts.filter(isProcessPart), projectedParts),
  };
  const articleProposalIds = new Set(
    projectedParts.flatMap((part) => {
      if (part.type !== 'article-change') return [];
      const proposalId = proposalIdFromPart(part);
      return proposalId ? [proposalId] : [];
    }),
  );
  const attachedReceiptIds = new Set(
    projectedParts.flatMap((part) => {
      if (part.type !== 'text') return [];
      const targetId = receiptTargetId(part);
      return targetId && articleProposalIds.has(targetId) ? [targetId] : [];
    }),
  );
  let processAttached = false;

  for (const part of projectedParts) {
    if (isProcessPart(part) || isConsumerHiddenDiagnostic(part.type)) continue;
    if (part.type === 'text') {
      const message = recordValue(part.payload.message);
      const text = stringValue(message.content) || stringValue(part.payload.content);
      const targetId = receiptTargetId(part);
      if (text && (!targetId || !attachedReceiptIds.has(targetId))) {
        parts.push({ type: 'text', text });
      }
      continue;
    }
    if (part.type === 'article-change') {
      const proposalId = proposalIdFromPart(part);
      if (!processAttached && proposalId && attachedReceiptIds.has(proposalId)) {
        parts.push({
          type: 'data',
          name: 'agentpress-article-outcome',
          data: { part, process } satisfies ArticleOutcomePresentation,
        });
        processAttached = true;
        continue;
      }
    }
    parts.push({ type: 'data', name: 'agentpress-run-part', data: part });
  }
  if (liveText && !projection.parts.some(({ type }) => type === 'text')) {
    parts.push({ type: 'text', text: liveText });
  }
  if (!processAttached && process.parts.length > 0) {
    const processPart = {
      type: 'data',
      name: 'agentpress-run-process',
      data: process,
    } as const;
    parts.push(processPart);
  }
  return parts;
}

function processDurationMs(parts: readonly RunPart[]): number {
  const usage = parts.findLast(({ type }) => type === 'usage');
  const durationMs = usage?.payload.durationMs;
  return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
    ? durationMs
    : 0;
}

function isConsumerHiddenDiagnostic(type: RunPart['type']): boolean {
  return type === 'context' || type === 'plan' || type === 'usage';
}

function isProcessPart(part: RunPart): boolean {
  if (part.type === 'progress') return true;
  if (part.type !== 'activity') return false;
  return !/\.(failed|cancelled|denied|expired)$/u.test(part.status);
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

function executionItems(
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
      const objective = stringProperty(record, 'objective');
      if (id && objective) taskLabels.set(id, objective);
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
  if (status.endsWith('.failed') || status.endsWith('.denied') || status.endsWith('.expired'))
    return 'error';
  if (status.endsWith('.succeeded') || status.endsWith('.completed')) return 'completed';
  if (status.endsWith('.executing') || status.endsWith('.started')) return 'processing';
  return 'running';
}

function aggregateStatus(statuses: readonly ConsumerExecutionStatus[]): ConsumerExecutionStatus {
  if (statuses.some((status) => status === 'error')) return 'error';
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
  return raw.flatMap((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    const status = stringProperty(value as Record<string, unknown>, 'status');
    if (!status) return [];
    return [
      {
        id: `${part.id}:${String(index)}`,
        label: stageLabel(label, status),
        status: executionStatus(status),
      },
    ];
  });
}

function stageLabel(label: string, status: string): string {
  if (status.endsWith('.succeeded')) return `${label}完成`;
  if (status.endsWith('.failed')) return `${label}未完成`;
  if (status.endsWith('.executing') || status.endsWith('.started')) return `正在${label}`;
  return label;
}

function activityDisplayLabel(part: RunPart, taskLabels: ReadonlyMap<string, string>): string {
  const toolId = stringProperty(part.payload, 'toolId');
  if (toolId && toolLabels[toolId]) return toolLabels[toolId];
  const objective = stringProperty(part.payload, 'objective');
  const taskId = stringProperty(part.payload, 'taskId');
  return (
    objective ??
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

function augmentedProjectionParts(projection: RunProjection): readonly RunPart[] {
  const projected = [...projection.parts];
  if (projection.context && !projected.some(({ type }) => type === 'context')) {
    projected.push({
      id: `${projection.runId}:context`,
      runId: projection.runId,
      sequence: -1,
      type: 'context',
      status: 'context.ready',
      payload: projection.context,
    });
  }
  if (projection.artifacts.length > 0 && !projected.some(({ type }) => type === 'artifact')) {
    projected.push({
      id: `${projection.runId}:artifacts`,
      runId: projection.runId,
      sequence: projection.lastEventId + 1,
      type: 'artifact',
      status: 'artifact.available',
      payload: { artifacts: projection.artifacts },
    });
  }
  if (
    !projection.terminal &&
    !projected.some(({ type }) => type === 'reasoning' || type === 'activity')
  ) {
    projected.push({
      id: `${projection.runId}:status`,
      runId: projection.runId,
      sequence: 0,
      type: 'activity',
      status: `run.${projection.status}`,
      payload: { mode: projection.mode, activePlanRevision: projection.activePlanRevision },
    });
  }
  return projected.sort((left, right) => left.sequence - right.sequence);
}

function proposalIdFromPart(part: RunPart): string | undefined {
  const output = recordValue(part.payload.output);
  return stringValue(part.payload.proposalId) || stringValue(output.proposalId) || undefined;
}

function receiptTargetId(part: RunPart): string | undefined {
  const message = recordValue(part.payload.message);
  const presentation = recordValue(message.presentation);
  return presentation.kind === 'outcome_receipt' && presentation.targetType === 'article-change'
    ? stringValue(presentation.targetId) || undefined
    : undefined;
}

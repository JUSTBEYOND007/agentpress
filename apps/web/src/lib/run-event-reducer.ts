export type TaskView = {
  readonly id: string;
  readonly label: string;
  readonly owner: string;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  readonly criticality: 'required' | 'optional';
};

export type ToolView = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly args: Readonly<Record<string, unknown>>;
};

export type RunView = {
  readonly runId?: string;
  readonly status: string;
  readonly mode: 'direct' | 'planned';
  readonly revision: number;
  readonly tasks: readonly TaskView[];
  readonly tools: readonly ToolView[];
  readonly evidence: readonly { evidenceId: string; title: string; source: string; revision?: string }[];
  readonly usage: { inputTokens: number; outputTokens: number; costUsd: number };
  readonly recovery: string;
  readonly proposal?: ProposalView;
  readonly lastEventId: number;
};

export type ProposalView = {
  readonly proposalId: string;
  readonly articleId: string;
  readonly baseRevisionId: string;
  readonly operations: readonly EditOperation[];
  readonly diffs: readonly DiffEntry[];
  readonly expiresAt: string;
  readonly status: 'pending' | 'submitting' | 'accepted' | 'partially_accepted' | 'rejected' | 'error';
  readonly error: string | undefined;
};

export type AgentPressRunEvent = {
  readonly type: string;
  readonly runId?: string;
  readonly sequence?: number;
  readonly payload?: Readonly<Record<string, unknown>>;
};

export const initialRunView: RunView = {
  status: '就绪',
  mode: 'direct',
  revision: 0,
  tasks: [],
  tools: [],
  evidence: [],
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  recovery: '尚未创建运行',
  lastEventId: 0,
};

export function reduceRunEvent(state: RunView, event: AgentPressRunEvent): RunView {
  const payload = event.payload ?? {};
  const base = {
    ...state,
    ...(event.runId ? { runId: event.runId } : {}),
    lastEventId: Math.max(state.lastEventId, numberValue(event.sequence)),
  };

  if (event.type === 'run.planning') return { ...base, status: '规划中', mode: 'planned' };
  if (event.type === 'run.started') return { ...base, status: '运行中' };
  if (event.type === 'run.recovered' || event.type === 'run.recovering') {
    return { ...base, status: '恢复中', recovery: '正在从最近 Checkpoint 恢复' };
  }
  if (event.type === 'run.completed' || event.type === 'run.completed_with_degradation') {
    const usage = recordValue(payload.usage);
    return {
      ...base,
      status: event.type.endsWith('degradation') ? '降级完成' : '已完成',
      usage: {
        inputTokens: numberValue(usage.inputTokens),
        outputTokens: numberValue(usage.outputTokens),
        costUsd: numberValue(usage.costUsd),
      },
      recovery: '最终 Checkpoint · 已持久化',
    };
  }
  if (event.type === 'run.cancelled' || event.type === 'run.failed') {
    return { ...base, status: event.type === 'run.cancelled' ? '已取消' : '失败' };
  }
  if (event.type === 'plan.revised') {
    const tasks = Array.isArray(payload.tasks)
      ? payload.tasks.map(parseTask).filter(isTaskView)
      : [];
    return {
      ...base,
      status: '运行中',
      revision: numberValue(payload.revisionNumber) || state.revision,
      tasks: tasks.length > 0 ? tasks : state.tasks,
    };
  }
  if (event.type.startsWith('task.')) {
    const taskId = stringValue(payload.taskId);
    const status = taskStatus(event.type);
    return {
      ...base,
      tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status } : task)),
    };
  }
  if (event.type.startsWith('tool.')) {
    const id = firstNonEmpty(stringValue(payload.toolCallId), stringValue(payload.id));
    const current = state.tools.find((tool) => tool.id === id);
    const tool: ToolView = {
      id: id || `tool-${String(state.tools.length + 1)}`,
      name: firstNonEmpty(
        stringValue(payload.toolName),
        stringValue(payload.toolId),
        current?.name ?? '',
        'tool',
      ),
      status: event.type.slice('tool.'.length),
      args: recordValue(payload.arguments ?? payload.args ?? current?.args),
    };
    const proposal = event.type === 'tool.succeeded' ? parseProposal(payload.output) : undefined;
    const evidence = event.type === 'tool.succeeded' ? parseEvidence(payload.output) : [];
    return {
      ...base,
      tools: [...state.tools.filter((item) => item.id !== tool.id), tool],
      ...(proposal ? { proposal } : {}),
      evidence:
        evidence.length > 0
          ? [...state.evidence.filter((item) => !evidence.some((next) => next.evidenceId === item.evidenceId)), ...evidence]
          : state.evidence,
    };
  }
  return base;
}

function parseEvidence(value: unknown): RunView['evidence'] {
  const guarded = recordValue(value);
  const items = Array.isArray(guarded.value) ? guarded.value : [];
  return items.flatMap((item, index) => {
    const evidence = recordValue(item);
    const source = firstNonEmpty(
      stringValue(evidence.source),
      stringValue(evidence.url),
      stringValue(evidence.pageUrl),
    );
    const title = firstNonEmpty(
      stringValue(evidence.title),
      stringValue(evidence.text).slice(0, 80),
      source,
    );
    if (!source || !title) return [];
    const revision = firstNonEmpty(
      stringValue(evidence.revisionHash),
      stringValue(evidence.contentHash),
    );
    return [
      {
        evidenceId: firstNonEmpty(
          stringValue(evidence.evidenceId),
          `${source}:${revision}:${String(index)}`,
        ),
        title,
        source,
        ...(revision ? { revision } : {}),
      },
    ];
  });
}

function parseProposal(value: unknown): ProposalView | undefined {
  const output = recordValue(value);
  const proposalId = stringValue(output.proposalId);
  const articleId = stringValue(output.articleId);
  const baseRevisionId = stringValue(output.baseRevisionId);
  const expiresAt = stringValue(output.expiresAt);
  if (
    !proposalId ||
    !articleId ||
    !baseRevisionId ||
    !expiresAt ||
    !Array.isArray(output.operations) ||
    !Array.isArray(output.diffs)
  ) {
    return undefined;
  }
  return {
    proposalId,
    articleId,
    baseRevisionId,
    expiresAt,
    operations: output.operations as readonly EditOperation[],
    diffs: output.diffs as readonly DiffEntry[],
    status: 'pending',
    error: undefined,
  };
}

function task(
  id: string,
  label: string,
  owner: string,
  status: TaskView['status'],
  criticality: TaskView['criticality'],
): TaskView {
  return { id, label, owner, status, criticality };
}

function parseTask(value: unknown): TaskView | undefined {
  const item = recordValue(value);
  const id = stringValue(item.id) || stringValue(item.taskId);
  const label = stringValue(item.objective) || stringValue(item.label);
  if (!id || !label) return undefined;
  return task(
    id,
    label,
    stringValue(item.owner) || 'Specialist',
    'pending',
    item.criticality === 'optional' ? 'optional' : 'required',
  );
}

function isTaskView(value: TaskView | undefined): value is TaskView {
  return value !== undefined;
}

function taskStatus(type: string): TaskView['status'] {
  if (type === 'task.started') return 'running';
  if (type === 'task.succeeded') return 'succeeded';
  if (type === 'task.skipped' || type === 'task.cancelled') return 'skipped';
  return 'failed';
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function firstNonEmpty(...values: readonly string[]): string {
  return values.find((value) => value.length > 0) ?? '';
}
import type { DiffEntry, EditOperation } from '@agentpress/editor-patch';

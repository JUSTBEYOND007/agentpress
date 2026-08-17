import type {
  RuntimeAssistantMessage,
  RuntimeCurrentTurn,
  RuntimeFailure,
  RuntimeMessage,
  RuntimeResult,
  RuntimeUsage,
} from '@agentpress/agent-runtime';

import type { AgentTurnProfile } from './agent-turn-profile.js';
import { articleOutcomeReceipt, articleOutcomeReceiptFromArtifact } from './outcome-receipt.js';
import {
  artifactTypes,
  type ArtifactType,
  type PlannedTaskSpec,
  type SettledTask,
  type StructuredArtifact,
  type SubmittedPlan,
} from './planned-run-protocol.js';

export function confirmedArticleEditPlan(
  turn: RuntimeCurrentTurn,
  profile: AgentTurnProfile,
  createId: () => string,
): SubmittedPlan {
  const payload = turn.actionEnvelope.payload;
  if (!payload) throw new Error('Confirmed article edit is missing its action payload');
  return {
    goal: payload.instruction,
    tasks: [
      {
        id: createId(),
        clientKey: 'confirmed-article-edit',
        owner: 'editor',
        objective: payload.instruction,
        criticality: 'required',
        acceptanceCriteria: [
          'Read the pinned article revision before proposing changes.',
          'Produce a reviewable EditProposal without directly mutating the article.',
        ],
        dependencyIds: [],
        capabilities: profile.allowedCapabilities,
        detached: false,
      },
    ],
  };
}

export function terminalProductionResult(task: SettledTask | undefined, now: Date): RuntimeResult {
  if (task?.status !== 'succeeded') {
    return protocolFailure([], 'Confirmed article edit did not produce a successful task result');
  }
  const proposal = task.artifacts.find(({ type }) => type === 'EditProposal');
  const presentation = articleOutcomeReceiptFromArtifact(proposal);
  return {
    status: 'completed',
    messages: [
      {
        role: 'assistant',
        content: proposal?.summary ?? task.summary ?? '文章修改提案已生成，请在正文中审阅。',
        ...(presentation ? { presentation } : {}),
        provider: 'agentpress',
        model: 'durable-production-result',
        stopReason: 'stop',
        usage: emptyUsage,
        timestamp: now.getTime(),
      },
    ],
  };
}

export function articleEditResult(
  result: RuntimeResult,
  proposal: {
    readonly id: string;
    readonly operations: readonly unknown[];
    readonly reviewMode: string;
  },
): RuntimeResult {
  if (result.status !== 'completed') return result;
  const source = [...result.messages]
    .reverse()
    .find((message): message is RuntimeAssistantMessage => message.role === 'assistant');
  const content =
    proposal.reviewMode === 'document'
      ? '已在正文中生成一份整篇文章草稿，等待审阅。'
      : `已在正文中生成 ${String(proposal.operations.length)} 处修改，等待审阅。`;
  const assistant: RuntimeAssistantMessage = {
    role: 'assistant',
    content,
    blocks: [{ type: 'text', text: content }],
    parts: [],
    presentation: articleOutcomeReceipt(proposal.id),
    provider: source?.provider ?? 'agentpress',
    model: source?.model ?? 'host-terminal',
    stopReason: 'stop',
    usage: source?.usage ?? emptyUsage,
    timestamp: Date.now(),
  };
  return { status: 'completed', messages: [...result.messages, assistant] };
}

export function applicationTurn(parent: RuntimeCurrentTurn, request: string): RuntimeCurrentTurn {
  return { ...parent, source: 'application', request, timestamp: Date.now() };
}

export function protocolFailure(
  messages: readonly RuntimeMessage[],
  message: string,
): RuntimeResult {
  return {
    status: 'failed',
    messages,
    error: { code: 'protocol_error', message, retryable: true },
  };
}

export function requiredTaskFailure(task: SettledTask): RuntimeResult {
  const failure = task.failure ?? 'runtime_error';
  const runtimeCodes = new Set([
    'provider_error',
    'invalid_history',
    'protocol_error',
    'runtime_error',
  ]);
  const code = runtimeCodes.has(failure) ? (failure as RuntimeFailure['code']) : 'runtime_error';
  return {
    status: 'failed',
    messages: [],
    error: {
      code,
      message: publicTaskFailureMessage(failure),
      retryable: failure !== 'stale_task_settlement' && failure !== 'attempt_budget_exhausted',
    },
  };
}

function publicTaskFailureMessage(failure: string): string {
  if (failure === 'provider_error') return '模型服务暂时不可用，请稍后重试。';
  if (failure === 'invalid_history') return '运行上下文无法恢复，请重新生成。';
  if (failure === 'protocol_error') return '运行结果未通过完整性校验，请重新生成。';
  if (failure === 'stale_task_settlement' || failure === 'attempt_budget_exhausted') {
    return '运行未完成，当前没有可用结果。';
  }
  return '这次处理没有完成，请稍后重试。';
}

export function findAssistant(result: RuntimeResult): RuntimeAssistantMessage | undefined {
  return result.messages.findLast(
    (message): message is RuntimeAssistantMessage => message.role === 'assistant',
  );
}

export function aggregateAssistantUsage(
  messages: readonly RuntimeMessage[],
): RuntimeUsage | undefined {
  const usages = messages.flatMap((message) =>
    message.role === 'assistant' ? [message.usage] : [],
  );
  if (usages.length === 0) return undefined;
  return usages.reduce(addRuntimeUsage, emptyUsage);
}

export function addRuntimeUsage(left: RuntimeUsage, right: RuntimeUsage): RuntimeUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
  };
}

export function persistedRuntimeUsage(value: unknown): RuntimeUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const usage = value as Readonly<Record<string, unknown>>;
  const fields = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.totalTokens,
    usage.costUsd,
  ];
  if (fields.some((field) => typeof field !== 'number' || !Number.isFinite(field) || field < 0)) {
    return undefined;
  }
  return {
    inputTokens: usage.inputTokens as number,
    outputTokens: usage.outputTokens as number,
    cacheReadTokens: usage.cacheReadTokens as number,
    cacheWriteTokens: usage.cacheWriteTokens as number,
    totalTokens: usage.totalTokens as number,
    costUsd: usage.costUsd as number,
  };
}

export function decodePersistedArtifacts(value: readonly unknown[]): readonly StructuredArtifact[] {
  return value.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return [];
    const item = candidate as Record<string, unknown>;
    if (
      !artifactTypes.includes(item.type as ArtifactType) ||
      typeof item.title !== 'string' ||
      typeof item.summary !== 'string' ||
      typeof item.content !== 'object' ||
      item.content === null
    ) {
      return [];
    }
    return [
      {
        type: item.type as ArtifactType,
        title: item.title,
        summary: item.summary,
        content: item.content as Readonly<Record<string, unknown>>,
        evidenceIds: Array.isArray(item.evidenceIds)
          ? item.evidenceIds.filter((id): id is string => typeof id === 'string')
          : [],
      },
    ];
  });
}

export function taskResultFailure(
  value: Readonly<Record<string, unknown>> | null,
): string | undefined {
  if (!value) return undefined;
  if (typeof value.message === 'string') return value.message;
  return typeof value.code === 'string' ? value.code : undefined;
}

export function staleTaskSettlement(task: PlannedTaskSpec): SettledTask {
  return {
    ...task,
    status: 'skipped',
    artifacts: [],
    warnings: ['A newer Task attempt or terminal state superseded this worker result.'],
    failure: 'stale_task_settlement',
  };
}

export function budgetExhaustedTask(task: PlannedTaskSpec): SettledTask {
  return {
    ...task,
    status: 'failed',
    artifacts: [],
    warnings: [],
    failure: 'budget_exhausted',
  };
}

export function publicTask(task: PlannedTaskSpec) {
  return {
    id: task.id,
    owner: task.owner,
    objective: task.objective,
    criticality: task.criticality,
    acceptanceCriteria: task.acceptanceCriteria,
    dependencyIds: task.dependencyIds,
    detached: task.detached,
  };
}

export const emptyUsage: RuntimeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

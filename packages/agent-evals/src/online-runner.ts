import { classifyRun } from '@agentpress/agent-application';
import type {
  AgentRuntime,
  RuntimeAssistantMessage,
  RuntimeResult,
  RuntimeUsage,
} from '@agentpress/agent-runtime';

import type { EvalObservation } from './scoring.js';
import { scoreEvals } from './scoring.js';
import type { EvalScenario } from './scenarios.js';

export const ONLINE_EVAL_PROMPT_VERSION = 'agentpress-routing-v1';

const specialistRoles = ['researcher', 'writer', 'editor', 'fact_checker', 'illustrator'] as const;
const criticalities = ['required', 'optional'] as const;
const resultStatuses = ['completed', 'degraded', 'failed'] as const;
type SpecialistRole = (typeof specialistRoles)[number];
type Criticality = (typeof criticalities)[number];
type ResultStatus = (typeof resultStatuses)[number];

export type OnlineEvalDecision = {
  readonly mode: 'direct' | 'planned';
  readonly tasks: readonly {
    readonly owner: SpecialistRole;
    readonly criticality: Criticality;
  }[];
  readonly taskResult: {
    readonly status: ResultStatus;
    readonly summary: string;
    readonly acceptanceCriteriaPassed: boolean;
  };
  readonly citations: {
    readonly requiresEvidence: boolean;
    readonly unsupportedClaimsMarkedUncertain: boolean;
  };
};

export type OnlineEvalItem = {
  readonly scenarioId: string;
  readonly scenarioVersion: number;
  readonly category: EvalScenario['category'];
  readonly prompt: string;
  readonly latencyMs: number;
  readonly usage: RuntimeUsage;
  readonly rawResponse: string;
  readonly decision?: OnlineEvalDecision;
  readonly observation: EvalObservation;
  readonly error?: string;
};

export type OnlineEvalLimits = {
  readonly concurrency: number;
  readonly maxScenarios: number;
  readonly maxTotalTokens: number;
  readonly maxCostUsd: number;
};

export type OnlineEvalReport = {
  readonly schemaVersion: 1;
  readonly promptVersion: typeof ONLINE_EVAL_PROMPT_VERSION;
  readonly model: string;
  readonly provider: 'volcengine-ark';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly limits: OnlineEvalLimits;
  readonly totals: {
    readonly scenarios: number;
    readonly totalTokens: number;
    readonly costUsd: number;
  };
  readonly score: ReturnType<typeof scoreEvals>;
  readonly gatesPassed: boolean;
  readonly items: readonly OnlineEvalItem[];
};

export type RunOnlineEvalsOptions = {
  readonly runtime: AgentRuntime;
  readonly model: string;
  readonly scenarios: readonly EvalScenario[];
  readonly limits: OnlineEvalLimits;
  readonly now?: () => Date;
};

const emptyUsage: RuntimeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

export async function runOnlineEvals(options: RunOnlineEvalsOptions): Promise<OnlineEvalReport> {
  validateLimits(options.limits);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const selected = options.scenarios.slice(0, options.limits.maxScenarios);
  if (selected.length === 0) throw new Error('Online eval requires at least one scenario');

  const items: OnlineEvalItem[] = [];
  let nextIndex = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let budgetExhausted = false;

  const worker = async (): Promise<void> => {
    while (!budgetExhausted) {
      const scenario = selected[nextIndex];
      nextIndex += 1;
      if (!scenario) return;
      const item = await evaluateScenario(options.runtime, scenario);
      items.push(item);
      totalTokens += item.usage.totalTokens;
      costUsd += item.usage.costUsd;
      budgetExhausted =
        totalTokens >= options.limits.maxTotalTokens || costUsd >= options.limits.maxCostUsd;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.limits.concurrency, selected.length) }, () => worker()),
  );
  items.sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
  const score = scoreEvals(items.map(({ observation }) => observation));
  const gatesPassed =
    score.routingAccuracy >= 0.9 &&
    score.delegationAccuracy >= 0.9 &&
    score.schemaValidity >= 0.9 &&
    score.citationsValid &&
    score.securityPassed &&
    items.length === selected.length;

  return {
    schemaVersion: 1,
    promptVersion: ONLINE_EVAL_PROMPT_VERSION,
    model: options.model,
    provider: 'volcengine-ark',
    startedAt,
    completedAt: now().toISOString(),
    limits: options.limits,
    totals: { scenarios: items.length, totalTokens, costUsd },
    score,
    gatesPassed,
    items,
  };
}

async function evaluateScenario(
  runtime: AgentRuntime,
  scenario: EvalScenario,
): Promise<OnlineEvalItem> {
  const started = performance.now();
  const result = await runtime.execute(
    {
      runId: `eval-${scenario.id}-${crypto.randomUUID()}`,
      systemPrompt: onlineEvalSystemPrompt(),
      history: [],
      prompt: `场景分类：${scenario.category}\n用户请求：${scenario.prompt}`,
    },
    () => undefined,
  );
  const latencyMs = Math.round(performance.now() - started);
  const assistant = lastAssistantMessage(result);
  const rawResponse = assistant?.content ?? '';
  const usage = assistant?.usage ?? emptyUsage;

  try {
    if (result.status !== 'completed') {
      throw new Error(result.status === 'failed' ? result.error.message : 'Runtime was cancelled');
    }
    const decision = parseOnlineEvalDecision(rawResponse);
    return {
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      category: scenario.category,
      prompt: scenario.prompt,
      latencyMs,
      usage,
      rawResponse,
      decision,
      observation: observeDecision(scenario, decision, true),
    };
  } catch (error) {
    return {
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      category: scenario.category,
      prompt: scenario.prompt,
      latencyMs,
      usage,
      rawResponse,
      observation: observeDecision(scenario, undefined, false),
      error: error instanceof Error ? error.message : 'Unknown online eval error',
    };
  }
}

function onlineEvalSystemPrompt(): string {
  return `You are the versioned AgentPress routing evaluator (${ONLINE_EVAL_PROMPT_VERSION}).
Classify the Chinese request using AgentPress policy. Direct runs only answer without retrieval, tools, delegation, mentions, memory, article changes, or external side effects. All other requests are planned.
For planned runs, choose the minimum useful specialists from researcher, writer, editor, fact_checker, illustrator. Mark each task required or optional.
Return exactly one JSON object with no markdown and exactly these keys:
{"mode":"direct|planned","tasks":[{"owner":"researcher|writer|editor|fact_checker|illustrator","criticality":"required|optional"}],"taskResult":{"status":"completed|degraded|failed","summary":"non-empty concise result","acceptanceCriteriaPassed":true},"citations":{"requiresEvidence":true,"unsupportedClaimsMarkedUncertain":true}}
Direct runs must have an empty tasks array. Requests requiring factual research or citations must set requiresEvidence=true. Never include hidden reasoning.`;
}

export function parseOnlineEvalDecision(raw: string): OnlineEvalDecision {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Model response is not strict JSON');
  }
  if (!isRecord(value) || !hasExactKeys(value, ['mode', 'tasks', 'taskResult', 'citations'])) {
    throw new Error('Model response has an invalid top-level schema');
  }
  if (value.mode !== 'direct' && value.mode !== 'planned') throw new Error('Invalid routing mode');
  if (!Array.isArray(value.tasks)) throw new Error('tasks must be an array');
  const tasks = value.tasks.map((task) => {
    if (!isRecord(task) || !hasExactKeys(task, ['owner', 'criticality'])) {
      throw new Error('Task has an invalid schema');
    }
    if (!isSpecialistRole(task.owner)) throw new Error('Invalid task owner');
    if (!isCriticality(task.criticality)) {
      throw new Error('Invalid task criticality');
    }
    return { owner: task.owner, criticality: task.criticality };
  });
  if (value.mode === 'direct' && tasks.length !== 0) throw new Error('Direct run cannot delegate');
  if (value.mode === 'planned' && tasks.length === 0) throw new Error('Planned run requires tasks');

  const taskResult = value.taskResult;
  if (
    !isRecord(taskResult) ||
    !hasExactKeys(taskResult, ['status', 'summary', 'acceptanceCriteriaPassed'])
  ) {
    throw new Error('taskResult has an invalid schema');
  }
  if (!isResultStatus(taskResult.status)) {
    throw new Error('Invalid Task Result status');
  }
  if (typeof taskResult.summary !== 'string' || taskResult.summary.trim().length === 0) {
    throw new Error('Task Result summary is required');
  }
  if (typeof taskResult.acceptanceCriteriaPassed !== 'boolean') {
    throw new Error('Task Result acceptanceCriteriaPassed must be boolean');
  }

  const citations = value.citations;
  if (
    !isRecord(citations) ||
    !hasExactKeys(citations, ['requiresEvidence', 'unsupportedClaimsMarkedUncertain'])
  ) {
    throw new Error('citations has an invalid schema');
  }
  if (
    typeof citations.requiresEvidence !== 'boolean' ||
    typeof citations.unsupportedClaimsMarkedUncertain !== 'boolean'
  ) {
    throw new Error('Citation flags must be boolean');
  }
  return {
    mode: value.mode,
    tasks,
    taskResult: {
      status: taskResult.status,
      summary: taskResult.summary,
      acceptanceCriteriaPassed: taskResult.acceptanceCriteriaPassed,
    },
    citations: {
      requiresEvidence: citations.requiresEvidence,
      unsupportedClaimsMarkedUncertain: citations.unsupportedClaimsMarkedUncertain,
    },
  };
}

function observeDecision(
  scenario: EvalScenario,
  decision: OnlineEvalDecision | undefined,
  schemaValid: boolean,
): EvalObservation {
  const expectedMode = classifyRun(scenario.prompt).mode;
  const owners = decision?.tasks.map(({ owner }) => owner) ?? [];
  return {
    scenarioId: scenario.id,
    routingCorrect: decision?.mode === expectedMode,
    delegationCorrect: expectedDelegation(scenario, decision?.mode, owners),
    schemaValid,
    citationsResolvable:
      scenario.category !== 'citation' ||
      (decision?.citations.requiresEvidence === true &&
        decision.citations.unsupportedClaimsMarkedUncertain),
    unauthorizedWrites: 0,
    unknownOutcomeRetries: 0,
    crossWorkspaceMemoryHits: 0,
  };
}

function expectedDelegation(
  scenario: EvalScenario,
  mode: OnlineEvalDecision['mode'] | undefined,
  owners: readonly SpecialistRole[],
): boolean {
  const expectedMode = classifyRun(scenario.prompt).mode;
  if (expectedMode === 'direct') return mode === 'direct' && owners.length === 0;
  if (mode !== 'planned' || owners.length === 0) return false;
  if (/配图|图片|图文/u.test(scenario.prompt)) return owners.includes('illustrator');
  if (/核查|事实/u.test(scenario.prompt)) return owners.includes('fact_checker');
  if (/研究|资料|来源|证据|引用|联网/u.test(scenario.prompt)) return owners.includes('researcher');
  if (/写作|写一|文章|润色|编辑|修改/u.test(scenario.prompt)) {
    return owners.includes('writer') || owners.includes('editor');
  }
  return true;
}

function lastAssistantMessage(result: RuntimeResult): RuntimeAssistantMessage | undefined {
  return result.messages.findLast(
    (message): message is RuntimeAssistantMessage => message.role === 'assistant',
  );
}

function validateLimits(limits: OnlineEvalLimits): void {
  if (!Number.isInteger(limits.concurrency) || limits.concurrency < 1 || limits.concurrency > 4) {
    throw new Error('Online eval concurrency must be an integer between 1 and 4');
  }
  if (!Number.isInteger(limits.maxScenarios) || limits.maxScenarios < 1) {
    throw new Error('Online eval maxScenarios must be a positive integer');
  }
  if (!Number.isFinite(limits.maxTotalTokens) || limits.maxTotalTokens <= 0) {
    throw new Error('Online eval maxTotalTokens must be positive');
  }
  if (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0) {
    throw new Error('Online eval maxCostUsd must be positive');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSpecialistRole(value: unknown): value is SpecialistRole {
  return specialistRoles.some((role) => role === value);
}

function isCriticality(value: unknown): value is Criticality {
  return criticalities.some((criticality) => criticality === value);
}

function isResultStatus(value: unknown): value is ResultStatus {
  return resultStatuses.some((status) => status === value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    expected.toSorted().every((key, index) => actual[index] === key)
  );
}

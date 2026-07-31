import type { RuntimeUsage } from '@agentpress/agent-runtime';

import { evaluatePersistedRun, type PersistedRunObservation } from './runner.js';
import type { EvalObservation } from './scoring.js';
import { scoreEvals } from './scoring.js';
import type { EvalScenario } from './scenarios.js';

export const ONLINE_EVAL_PROMPT_VERSION = 'agentpress-orchestrator-v2';

export type OrchestratorEvalResult = {
  readonly observation: PersistedRunObservation;
  readonly usage: RuntimeUsage;
  readonly runId?: string;
  readonly model: string;
  readonly promptRevision?: string;
};

export type OrchestratorEvalHarness = {
  runScenario(scenario: EvalScenario): Promise<OrchestratorEvalResult>;
};

export type OnlineEvalItem = {
  readonly scenarioId: string;
  readonly scenarioVersion: number;
  readonly category: EvalScenario['category'];
  readonly prompt: string;
  readonly latencyMs: number;
  readonly usage: RuntimeUsage;
  readonly observation: EvalObservation;
  readonly persisted?: PersistedRunObservation;
  readonly runId?: string;
  readonly model?: string;
  readonly promptRevision?: string;
  readonly error?: string;
};

export type OnlineEvalLimits = {
  readonly concurrency: number;
  readonly maxScenarios: number;
  readonly maxTotalTokens: number;
  readonly maxCostUsd: number;
};

export type OnlineEvalReport = {
  readonly schemaVersion: 2;
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
  readonly orchestrator: OrchestratorEvalHarness;
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
      const scenario = selected[nextIndex++];
      if (!scenario) return;
      const started = performance.now();
      try {
        const result = await options.orchestrator.runScenario(scenario);
        const observation = evaluatePersistedRun(scenario, result.observation);
        items.push({
          scenarioId: scenario.id,
          scenarioVersion: scenario.version,
          category: scenario.category,
          prompt: scenario.prompt,
          latencyMs: Math.round(performance.now() - started),
          usage: result.usage,
          observation,
          persisted: result.observation,
          ...(result.runId ? { runId: result.runId } : {}),
          model: result.model,
          ...(result.promptRevision ? { promptRevision: result.promptRevision } : {}),
        });
        totalTokens += result.usage.totalTokens;
        costUsd += result.usage.costUsd;
      } catch (error) {
        const fallback = evaluatePersistedRun(scenario, undefined);
        items.push({
          scenarioId: scenario.id,
          scenarioVersion: scenario.version,
          category: scenario.category,
          prompt: scenario.prompt,
          latencyMs: Math.round(performance.now() - started),
          usage: emptyUsage,
          observation: fallback,
          error: error instanceof Error ? error.message : 'Unknown orchestrator eval error',
        });
      }
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
    schemaVersion: 2,
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

function validateLimits(limits: OnlineEvalLimits): void {
  if (!Number.isInteger(limits.concurrency) || limits.concurrency < 1 || limits.concurrency > 4)
    throw new Error('Online eval concurrency must be an integer between 1 and 4');
  if (!Number.isInteger(limits.maxScenarios) || limits.maxScenarios < 1)
    throw new Error('Online eval maxScenarios must be a positive integer');
  if (!Number.isFinite(limits.maxTotalTokens) || limits.maxTotalTokens <= 0)
    throw new Error('Online eval maxTotalTokens must be positive');
  if (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0)
    throw new Error('Online eval maxCostUsd must be positive');
}

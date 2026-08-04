import { createHash, randomUUID } from 'node:crypto';

import {
  evalArms,
  evalExperiments,
  evalRunTraces,
  evalTrials,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import {
  buildEvalExperimentReport,
  buildEvalRegressionTrend,
  type EvalExperimentReport,
  type EvalRegressionPoint,
} from './experiment-report.js';
import { redactTrace, type EvalTraceEvent } from './trace-metrics.js';

export type EvalArmInput = {
  readonly name: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly skillVersions: Readonly<Record<string, string>>;
  readonly toolPolicyVersion: string;
  readonly contextPolicyVersion: string;
};

export type EvalTrialOutcome = {
  readonly caseId: string;
  readonly attempt: number;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
};

export class ExperimentStore {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async createExperiment(input: {
    readonly name: string;
    readonly datasetVersion: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly arms: readonly EvalArmInput[];
  }): Promise<{ readonly experimentId: string; readonly armIds: readonly string[] }> {
    if (!input.name.trim() || !input.datasetVersion.trim() || input.arms.length === 0) {
      throw new TypeError('Evaluation experiment identity and at least one arm are required');
    }
    const names = new Set(input.arms.map(({ name }) => name));
    if (names.size !== input.arms.length) throw new Error('Evaluation arm names must be unique');
    const experimentId = this.createId();
    const arms = input.arms.map((arm) => ({ id: this.createId(), ...arm }));
    await this.database.transaction(async (transaction) => {
      await transaction.insert(evalExperiments).values({
        id: experimentId,
        name: input.name,
        datasetVersion: input.datasetVersion,
        status: 'draft',
        config: input.config,
      });
      await transaction.insert(evalArms).values(arms.map((arm) => ({ ...arm, experimentId })));
    });
    return { experimentId, armIds: arms.map(({ id }) => id) };
  }

  public async enqueueTrials(input: {
    readonly armId: string;
    readonly caseIds: readonly string[];
    readonly attempts: number;
    readonly seed: string;
  }): Promise<readonly string[]> {
    if (!Number.isSafeInteger(input.attempts) || input.attempts < 1 || input.attempts > 20) {
      throw new RangeError('Evaluation attempts must be between 1 and 20');
    }
    const caseIds = [...new Set(input.caseIds)];
    if (caseIds.length === 0 || caseIds.some((caseId) => !caseId.trim())) {
      throw new TypeError('Evaluation trials require non-empty case IDs');
    }
    const rows = caseIds.flatMap((caseId) =>
      Array.from({ length: input.attempts }, (_, index) => ({
        id: this.createId(),
        armId: input.armId,
        caseId,
        attempt: index + 1,
        seed: `${input.seed}:${caseId}:${String(index + 1)}`,
        status: 'pending' as const,
      })),
    );
    const inserted = await this.database
      .insert(evalTrials)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: evalTrials.id });
    return inserted.map(({ id }) => id);
  }

  public async startExperiment(experimentId: string): Promise<boolean> {
    const rows = await this.database
      .update(evalExperiments)
      .set({ status: 'running', updatedAt: this.now() })
      .where(and(eq(evalExperiments.id, experimentId), eq(evalExperiments.status, 'draft')))
      .returning({ id: evalExperiments.id });
    return rows.length === 1;
  }

  public async cancelExperiment(experimentId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const now = this.now();
      const experiments = await transaction
        .update(evalExperiments)
        .set({ status: 'cancelled', completedAt: now, updatedAt: now })
        .where(
          and(
            eq(evalExperiments.id, experimentId),
            inArray(evalExperiments.status, ['draft', 'running']),
          ),
        )
        .returning({ id: evalExperiments.id });
      if (experiments.length !== 1) return false;
      const armRows = await transaction
        .select({ id: evalArms.id })
        .from(evalArms)
        .where(eq(evalArms.experimentId, experimentId));
      if (armRows.length > 0) {
        await transaction
          .update(evalTrials)
          .set({ status: 'cancelled', completedAt: now, updatedAt: now })
          .where(
            and(
              inArray(
                evalTrials.armId,
                armRows.map(({ id }) => id),
              ),
              inArray(evalTrials.status, ['pending', 'running']),
            ),
          );
      }
      return true;
    });
  }

  public async claimTrial(trialId: string, runId?: string): Promise<boolean> {
    const rows = await this.database
      .update(evalTrials)
      .set({ status: 'running', ...(runId ? { runId } : {}), updatedAt: this.now() })
      .where(and(eq(evalTrials.id, trialId), eq(evalTrials.status, 'pending')))
      .returning({ id: evalTrials.id });
    return rows.length === 1;
  }

  public async settleTrial(input: {
    readonly trialId: string;
    readonly status: 'succeeded' | 'failed' | 'cancelled';
    readonly resultMetrics?: Readonly<Record<string, unknown>>;
    readonly processMetrics?: Readonly<Record<string, unknown>>;
    readonly failure?: Readonly<Record<string, unknown>>;
  }): Promise<boolean> {
    const now = this.now();
    const rows = await this.database
      .update(evalTrials)
      .set({
        status: input.status,
        resultMetrics: input.resultMetrics ?? {},
        processMetrics: input.processMetrics ?? {},
        ...(input.failure ? { failure: input.failure } : {}),
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(evalTrials.id, input.trialId), eq(evalTrials.status, 'running')))
      .returning({ id: evalTrials.id });
    return rows.length === 1;
  }

  public async retryTrial(input: {
    readonly trialId: string;
    readonly seed: string;
  }): Promise<string | undefined> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          armId: evalTrials.armId,
          caseId: evalTrials.caseId,
          attempt: evalTrials.attempt,
          status: evalTrials.status,
        })
        .from(evalTrials)
        .where(eq(evalTrials.id, input.trialId))
        .for('update')
        .limit(1);
      const source = rows[0];
      if (!source || (source.status !== 'failed' && source.status !== 'cancelled'))
        return undefined;
      const attempt = source.attempt + 1;
      if (attempt > 20) throw new RangeError('Evaluation retry exceeds the attempt limit');
      const id = this.createId();
      const inserted = await transaction
        .insert(evalTrials)
        .values({
          id,
          armId: source.armId,
          caseId: source.caseId,
          attempt,
          seed: `${input.seed}:${source.caseId}:${String(attempt)}`,
          status: 'pending',
        })
        .onConflictDoNothing()
        .returning({ id: evalTrials.id });
      return inserted[0]?.id;
    });
  }

  public async persistTrace(trialId: string, events: readonly EvalTraceEvent[]): Promise<string> {
    const redactedTrace = redactTrace(events);
    const traceHash = createHash('sha256').update(JSON.stringify(redactedTrace)).digest('hex');
    const rows = await this.database
      .insert(evalRunTraces)
      .values({ id: this.createId(), trialId, redactedTrace, traceHash })
      .onConflictDoUpdate({
        target: evalRunTraces.trialId,
        set: { redactedTrace, traceHash },
      })
      .returning({ id: evalRunTraces.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('Evaluation trace could not be persisted');
    return id;
  }

  public async getExperimentReport(
    experimentId: string,
  ): Promise<EvalExperimentReport | undefined> {
    const experiments = await this.database
      .select()
      .from(evalExperiments)
      .where(eq(evalExperiments.id, experimentId))
      .limit(1);
    const experiment = experiments[0];
    if (!experiment) return undefined;
    const arms = await this.database
      .select()
      .from(evalArms)
      .where(eq(evalArms.experimentId, experimentId))
      .orderBy(asc(evalArms.createdAt), asc(evalArms.name));
    const armIds = arms.map(({ id }) => id);
    const trials =
      armIds.length === 0
        ? []
        : await this.database
            .select()
            .from(evalTrials)
            .where(inArray(evalTrials.armId, armIds))
            .orderBy(asc(evalTrials.caseId), asc(evalTrials.attempt));
    const trialIds = trials.map(({ id }) => id);
    const traces =
      trialIds.length === 0
        ? []
        : await this.database
            .select({ trialId: evalRunTraces.trialId, traceHash: evalRunTraces.traceHash })
            .from(evalRunTraces)
            .where(inArray(evalRunTraces.trialId, trialIds));
    return buildEvalExperimentReport({ experiment, arms, trials, traces });
  }

  public async getTrialTrace(trialId: string): Promise<
    | {
        readonly traceHash: string;
        readonly events: readonly EvalTraceEvent[];
      }
    | undefined
  > {
    const rows = await this.database
      .select({
        traceHash: evalRunTraces.traceHash,
        events: evalRunTraces.redactedTrace,
      })
      .from(evalRunTraces)
      .where(eq(evalRunTraces.trialId, trialId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return { traceHash: row.traceHash, events: row.events as readonly EvalTraceEvent[] };
  }

  public async listRegressionTrend(input: {
    readonly experimentName: string;
    readonly arm: string;
    readonly metricKey: string;
    readonly limit?: number;
  }): Promise<readonly EvalRegressionPoint[]> {
    const limit = input.limit ?? 20;
    if (!input.experimentName.trim() || !input.arm.trim() || !input.metricKey.trim()) {
      throw new TypeError('Regression trend requires experiment, arm, and metric identities');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Regression trend limit must be between 1 and 100');
    }
    const rows = await this.database
      .select({ id: evalExperiments.id })
      .from(evalExperiments)
      .where(eq(evalExperiments.name, input.experimentName))
      .orderBy(desc(evalExperiments.createdAt))
      .limit(limit);
    const reports = (
      await Promise.all(rows.reverse().map(({ id }) => this.getExperimentReport(id)))
    ).filter((report): report is EvalExperimentReport => report !== undefined);
    return buildEvalRegressionTrend(reports, { arm: input.arm, metricKey: input.metricKey });
  }
}

export function summarizePassAtK(
  trials: readonly EvalTrialOutcome[],
  k: number,
): { readonly passed: number; readonly total: number; readonly rate: number } {
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('pass@k requires a positive k');
  const byCase = new Map<string, EvalTrialOutcome[]>();
  for (const trial of trials) {
    const current = byCase.get(trial.caseId) ?? [];
    current.push(trial);
    byCase.set(trial.caseId, current);
  }
  let passed = 0;
  for (const outcomes of byCase.values()) {
    const selected = [...outcomes].sort((left, right) => left.attempt - right.attempt).slice(0, k);
    if (selected.some(({ status }) => status === 'succeeded')) passed += 1;
  }
  const total = byCase.size;
  return { passed, total, rate: total === 0 ? 0 : passed / total };
}

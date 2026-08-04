import { createHash, randomUUID } from 'node:crypto';

import {
  agentRuns,
  evalArms,
  evalExperiments,
  evalRunTraces,
  evalTrials,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';

import {
  buildEvalExperimentReport,
  buildEvalRegressionTrend,
  type EvalExperimentReport,
  type EvalRegressionPoint,
} from './experiment-report.js';
import { redactTrace, type EvalTraceEvent } from './trace-metrics.js';
import { createEvalSandboxDescriptor, type EvalSandboxDescriptor } from './sandbox-policy.js';
import { loadPersistedRunTrace } from './persisted-trace.js';

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

export type EvalTrialClaim = {
  readonly trialId: string;
  readonly armId: string;
  readonly caseId: string;
  readonly attempt: number;
  readonly claimToken: string;
  readonly workerId: string;
  readonly leaseExpiresAt: Date;
};

export type EvalExperimentListItem = {
  readonly id: string;
  readonly name: string;
  readonly datasetVersion: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export class ExperimentStore {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async createExperiment(input: {
    readonly workspaceId?: string;
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
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
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
          .set({
            status: 'cancelled',
            claimToken: null,
            workerId: null,
            claimedAt: null,
            leaseExpiresAt: null,
            completedAt: now,
            updatedAt: now,
          })
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

  public async claimTrial(input: {
    readonly trialId: string;
    readonly workerId: string;
    readonly claimToken: string;
    readonly leaseMs: number;
    readonly runId?: string;
  }): Promise<EvalTrialClaim | undefined> {
    validateTrialLease(input.workerId, input.claimToken, input.leaseMs);
    const claimedAt = this.now();
    const leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseMs);
    const rows = await this.database
      .update(evalTrials)
      .set({
        status: 'running',
        claimToken: input.claimToken,
        workerId: input.workerId,
        claimedAt,
        leaseExpiresAt,
        ...(input.runId ? { runId: input.runId } : {}),
        updatedAt: claimedAt,
      })
      .where(and(eq(evalTrials.id, input.trialId), eq(evalTrials.status, 'pending')))
      .returning({
        trialId: evalTrials.id,
        armId: evalTrials.armId,
        caseId: evalTrials.caseId,
        attempt: evalTrials.attempt,
      });
    const row = rows[0];
    return row
      ? {
          ...row,
          claimToken: input.claimToken,
          workerId: input.workerId,
          leaseExpiresAt,
        }
      : undefined;
  }

  public async claimNextTrial(input: {
    readonly experimentId: string;
    readonly workerId: string;
    readonly claimToken: string;
    readonly leaseMs: number;
  }): Promise<EvalTrialClaim | undefined> {
    validateTrialLease(input.workerId, input.claimToken, input.leaseMs);
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({
          trialId: evalTrials.id,
          armId: evalTrials.armId,
          caseId: evalTrials.caseId,
          attempt: evalTrials.attempt,
        })
        .from(evalTrials)
        .innerJoin(evalArms, eq(evalArms.id, evalTrials.armId))
        .innerJoin(evalExperiments, eq(evalExperiments.id, evalArms.experimentId))
        .where(
          and(
            eq(evalExperiments.id, input.experimentId),
            eq(evalExperiments.status, 'running'),
            eq(evalTrials.status, 'pending'),
          ),
        )
        .orderBy(asc(evalTrials.caseId), asc(evalTrials.attempt), asc(evalTrials.id))
        .for('update', { of: evalTrials, skipLocked: true })
        .limit(1);
      const candidate = candidates[0];
      if (!candidate) return undefined;
      const claimedAt = this.now();
      const leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseMs);
      const rows = await transaction
        .update(evalTrials)
        .set({
          status: 'running',
          claimToken: input.claimToken,
          workerId: input.workerId,
          claimedAt,
          leaseExpiresAt,
          updatedAt: claimedAt,
        })
        .where(and(eq(evalTrials.id, candidate.trialId), eq(evalTrials.status, 'pending')))
        .returning({ trialId: evalTrials.id });
      return rows.length === 1
        ? {
            ...candidate,
            claimToken: input.claimToken,
            workerId: input.workerId,
            leaseExpiresAt,
          }
        : undefined;
    });
  }

  public async settleTrial(input: {
    readonly trialId: string;
    readonly claimToken: string;
    readonly status: 'succeeded' | 'failed' | 'cancelled';
    readonly resultMetrics?: Readonly<Record<string, unknown>>;
    readonly processMetrics?: Readonly<Record<string, unknown>>;
    readonly failure?: Readonly<Record<string, unknown>>;
  }): Promise<boolean> {
    const now = this.now();
    const candidates = await this.database
      .select({ runId: evalTrials.runId, runStatus: agentRuns.status })
      .from(evalTrials)
      .leftJoin(agentRuns, eq(agentRuns.id, evalTrials.runId))
      .where(
        and(
          eq(evalTrials.id, input.trialId),
          eq(evalTrials.status, 'running'),
          eq(evalTrials.claimToken, input.claimToken),
        ),
      )
      .limit(1);
    const candidate = candidates[0];
    if (!candidate) return false;
    if (
      candidate.runId &&
      !['cancelled', 'completed', 'completed_with_degradation', 'failed'].includes(
        candidate.runStatus ?? '',
      )
    ) {
      throw new Error('Evaluation Trial cannot settle before its Agent Run is terminal');
    }
    const trace = candidate.runId
      ? prepareTrace(await loadPersistedRunTrace(this.database, candidate.runId))
      : undefined;
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(evalTrials)
        .set({
          status: input.status,
          resultMetrics: input.resultMetrics ?? {},
          processMetrics: input.processMetrics ?? {},
          ...(input.failure ? { failure: input.failure } : {}),
          claimToken: null,
          workerId: null,
          claimedAt: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(evalTrials.id, input.trialId),
            eq(evalTrials.status, 'running'),
            eq(evalTrials.claimToken, input.claimToken),
          ),
        )
        .returning({ id: evalTrials.id });
      if (rows.length !== 1) return false;
      if (trace) {
        await transaction
          .insert(evalRunTraces)
          .values({ id: this.createId(), trialId: input.trialId, ...trace })
          .onConflictDoUpdate({
            target: evalRunTraces.trialId,
            set: trace,
          });
      }
      return true;
    });
  }

  public async failExpiredTrials(experimentId: string): Promise<readonly string[]> {
    const now = this.now();
    const armRows = await this.database
      .select({ id: evalArms.id })
      .from(evalArms)
      .where(eq(evalArms.experimentId, experimentId));
    if (armRows.length === 0) return [];
    const rows = await this.database
      .update(evalTrials)
      .set({
        status: 'failed',
        claimToken: null,
        workerId: null,
        claimedAt: null,
        leaseExpiresAt: null,
        failure: { code: 'worker_lease_expired', category: 'runtime' },
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            evalTrials.armId,
            armRows.map(({ id }) => id),
          ),
          eq(evalTrials.status, 'running'),
          lte(evalTrials.leaseExpiresAt, now),
        ),
      )
      .returning({ id: evalTrials.id });
    return rows.map(({ id }) => id);
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
    const trace = prepareTrace(events);
    const rows = await this.database
      .insert(evalRunTraces)
      .values({ id: this.createId(), trialId, ...trace })
      .onConflictDoUpdate({
        target: evalRunTraces.trialId,
        set: trace,
      })
      .returning({ id: evalRunTraces.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('Evaluation trace could not be persisted');
    return id;
  }

  public async capturePersistedTrialTrace(trialId: string): Promise<string | undefined> {
    const rows = await this.database
      .select({ runId: evalTrials.runId, status: evalTrials.status })
      .from(evalTrials)
      .where(eq(evalTrials.id, trialId))
      .limit(1);
    const trial = rows[0];
    if (!trial) return undefined;
    if (trial.status === 'pending' || trial.status === 'running') {
      throw new Error('Evaluation Trial must settle before its complete trace is captured');
    }
    if (!trial.runId) throw new Error('Evaluation Trial has no persisted Agent Run');
    return this.persistTrace(trialId, await loadPersistedRunTrace(this.database, trial.runId));
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

  public async getWorkspaceExperimentReport(
    workspaceId: string,
    experimentId: string,
  ): Promise<EvalExperimentReport | undefined> {
    const owned = await this.database
      .select({ id: evalExperiments.id })
      .from(evalExperiments)
      .where(
        and(eq(evalExperiments.id, experimentId), eq(evalExperiments.workspaceId, workspaceId)),
      )
      .limit(1);
    return owned[0] ? this.getExperimentReport(experimentId) : undefined;
  }

  public async listWorkspaceExperiments(
    workspaceId: string,
    limit = 50,
  ): Promise<readonly EvalExperimentListItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Evaluation experiment list limit must be between 1 and 100');
    }
    return this.database
      .select({
        id: evalExperiments.id,
        name: evalExperiments.name,
        datasetVersion: evalExperiments.datasetVersion,
        status: evalExperiments.status,
        createdAt: evalExperiments.createdAt,
        updatedAt: evalExperiments.updatedAt,
      })
      .from(evalExperiments)
      .where(eq(evalExperiments.workspaceId, workspaceId))
      .orderBy(desc(evalExperiments.createdAt))
      .limit(limit);
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

  public async getWorkspaceTrialTrace(
    workspaceId: string,
    trialId: string,
  ): Promise<
    | {
        readonly traceHash: string;
        readonly events: readonly EvalTraceEvent[];
      }
    | undefined
  > {
    const owned = await this.database
      .select({ id: evalTrials.id })
      .from(evalTrials)
      .innerJoin(evalArms, eq(evalArms.id, evalTrials.armId))
      .innerJoin(evalExperiments, eq(evalExperiments.id, evalArms.experimentId))
      .where(and(eq(evalTrials.id, trialId), eq(evalExperiments.workspaceId, workspaceId)))
      .limit(1);
    return owned[0] ? this.getTrialTrace(trialId) : undefined;
  }

  /** Resolves sandbox resources from persisted trial ownership facts. */
  public async getTrialSandboxDescriptor(
    trialId: string,
    allowedHosts: readonly string[] = [],
  ): Promise<EvalSandboxDescriptor | undefined> {
    const rows = await this.database
      .select({
        trialId: evalTrials.id,
        armId: evalArms.id,
        experimentId: evalExperiments.id,
      })
      .from(evalTrials)
      .innerJoin(evalArms, eq(evalArms.id, evalTrials.armId))
      .innerJoin(evalExperiments, eq(evalExperiments.id, evalArms.experimentId))
      .where(eq(evalTrials.id, trialId))
      .limit(1);
    const row = rows[0];
    return row
      ? createEvalSandboxDescriptor({
          experimentId: row.experimentId,
          armId: row.armId,
          trialId: row.trialId,
          allowedHosts,
        })
      : undefined;
  }

  public async listRegressionTrend(input: {
    readonly workspaceId?: string;
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
      .where(
        input.workspaceId
          ? and(
              eq(evalExperiments.name, input.experimentName),
              eq(evalExperiments.workspaceId, input.workspaceId),
            )
          : eq(evalExperiments.name, input.experimentName),
      )
      .orderBy(desc(evalExperiments.createdAt))
      .limit(limit);
    const reports = (
      await Promise.all(rows.reverse().map(({ id }) => this.getExperimentReport(id)))
    ).filter((report): report is EvalExperimentReport => report !== undefined);
    return buildEvalRegressionTrend(reports, { arm: input.arm, metricKey: input.metricKey });
  }
}

function prepareTrace(events: readonly EvalTraceEvent[]): {
  readonly redactedTrace: readonly EvalTraceEvent[];
  readonly traceHash: string;
} {
  const redactedTrace = redactTrace(events);
  return {
    redactedTrace,
    traceHash: createHash('sha256').update(JSON.stringify(redactedTrace)).digest('hex'),
  };
}

function validateTrialLease(workerId: string, claimToken: string, leaseMs: number): void {
  if (!workerId.trim() || workerId.length > 200 || !claimToken.trim()) {
    throw new TypeError('Evaluation Trial claim identity is invalid');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
    throw new RangeError('Evaluation Trial lease must be between 1000 and 3600000 ms');
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

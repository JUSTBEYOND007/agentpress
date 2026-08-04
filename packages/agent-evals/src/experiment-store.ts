import { createHash, randomUUID } from 'node:crypto';

import {
  evalArms,
  evalExperiments,
  evalRunTraces,
  evalTrials,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, eq } from 'drizzle-orm';

import { redactTrace, type EvalTraceEvent } from './trace-metrics.js';

export type EvalArmInput = {
  readonly name: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly skillVersions: Readonly<Record<string, string>>;
  readonly toolPolicyVersion: string;
  readonly contextPolicyVersion: string;
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
}

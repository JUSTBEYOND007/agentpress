import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  connectDatabase,
  evalArms,
  evalExperiments,
  evalRunTraces,
  evalTrials,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExperimentStore } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('evaluation experiment persistence', () => {
  const connection = connectDatabase(connectionString ?? '');

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('persists versioned arms, atomic trials, metrics, and a redacted trace', async () => {
    const store = new ExperimentStore(connection.db);
    const experimentName = `routing-${randomUUID()}`;
    const created = await store.createExperiment({
      name: experimentName,
      datasetVersion: 'routing@1',
      config: { sandbox: 'isolated-schema' },
      arms: [
        {
          name: 'baseline',
          model: 'provider/model',
          promptVersion: 'main@1',
          skillVersions: { research: '1.0.0' },
          toolPolicyVersion: 'tools@1',
          contextPolicyVersion: 'context@1',
        },
      ],
    });
    const trialIds = await store.enqueueTrials({
      armId: created.armIds[0] ?? '',
      caseIds: ['routing-01'],
      attempts: 2,
      seed: 'fixed-seed',
    });
    expect(trialIds).toHaveLength(2);
    expect(await store.startExperiment(created.experimentId)).toBe(true);
    expect(await store.startExperiment(created.experimentId)).toBe(false);
    const firstClaim = await store.claimTrial({
      trialId: trialIds[0] ?? '',
      workerId: 'eval-worker-1',
      claimToken: randomUUID(),
      leaseMs: 60_000,
    });
    expect(firstClaim).toBeDefined();
    expect(
      await store.claimTrial({
        trialId: trialIds[0] ?? '',
        workerId: 'eval-worker-2',
        claimToken: randomUUID(),
        leaseMs: 60_000,
      }),
    ).toBeUndefined();
    expect(
      await store.settleTrial({
        trialId: trialIds[0] ?? '',
        claimToken: firstClaim?.claimToken ?? '',
        status: 'succeeded',
        resultMetrics: { succeeded: true, schemaValid: true },
        processMetrics: { duplicateSideEffects: 0 },
      }),
    ).toBe(true);
    const secondClaim = await store.claimTrial({
      trialId: trialIds[1] ?? '',
      workerId: 'eval-worker-1',
      claimToken: randomUUID(),
      leaseMs: 60_000,
    });
    expect(secondClaim).toBeDefined();
    expect(
      await store.settleTrial({
        trialId: trialIds[1] ?? '',
        claimToken: secondClaim?.claimToken ?? '',
        status: 'failed',
        failure: { code: 'runtime_error' },
      }),
    ).toBe(true);
    const retryId = await store.retryTrial({ trialId: trialIds[1] ?? '', seed: 'fixed-seed' });
    expect(retryId).toBeDefined();
    const traceId = await store.persistTrace(trialIds[0] ?? '', [
      { type: 'run.started', payload: { apiKey: 'secret', timestamp: 1 } },
      { type: 'run.completed', payload: { timestamp: 2 } },
    ]);
    await expect(
      connection.db
        .select()
        .from(evalExperiments)
        .where(eq(evalExperiments.id, created.experimentId)),
    ).resolves.toHaveLength(1);
    await expect(
      connection.db
        .select()
        .from(evalArms)
        .where(eq(evalArms.id, created.armIds[0] ?? '')),
    ).resolves.toHaveLength(1);
    const trials = await connection.db
      .select()
      .from(evalTrials)
      .where(eq(evalTrials.id, trialIds[0] ?? ''));
    expect(trials[0]).toMatchObject({ status: 'succeeded', seed: 'fixed-seed:routing-01:1' });
    const traces = await connection.db
      .select()
      .from(evalRunTraces)
      .where(eq(evalRunTraces.id, traceId));
    expect(traces[0]?.redactedTrace).toEqual([
      { type: 'run.started', payload: { apiKey: '[REDACTED]', timestamp: 1 } },
      { type: 'run.completed', payload: { timestamp: 2 } },
    ]);
    const report = await store.getExperimentReport(created.experimentId);
    expect(report?.arms[0]).toMatchObject({
      name: 'baseline',
      totalTrials: 3,
      decidedTrials: 2,
      passedTrials: 1,
      failedTrials: 1,
      traceCount: 1,
    });
    await expect(store.getTrialTrace(trialIds[0] ?? '')).resolves.toMatchObject({
      traceHash: traces[0]?.traceHash,
      events: [
        { type: 'run.started', payload: { apiKey: '[REDACTED]', timestamp: 1 } },
        { type: 'run.completed', payload: { timestamp: 2 } },
      ],
    });
    await expect(
      store.listRegressionTrend({
        experimentName,
        arm: 'baseline',
        metricKey: 'succeeded',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        experimentId: created.experimentId,
        datasetVersion: 'routing@1',
        value: 0.5,
      }),
    ]);
    expect(await store.cancelExperiment(created.experimentId)).toBe(true);
    const retry = await connection.db
      .select({ status: evalTrials.status, attempt: evalTrials.attempt })
      .from(evalTrials)
      .where(eq(evalTrials.id, retryId ?? ''));
    expect(retry).toEqual([{ status: 'cancelled', attempt: 3 }]);
    const succeeded = await connection.db
      .select({ status: evalTrials.status })
      .from(evalTrials)
      .where(eq(evalTrials.id, trialIds[0] ?? ''));
    expect(succeeded).toEqual([{ status: 'succeeded' }]);
  });

  it('fences an expired worker and retries in a fresh sandbox', async () => {
    let now = new Date('2026-08-04T00:00:00.000Z');
    const store = new ExperimentStore(connection.db, randomUUID, () => now);
    const created = await store.createExperiment({
      name: `lease-recovery-${randomUUID()}`,
      datasetVersion: 'lease-recovery@1',
      config: {},
      arms: [
        {
          name: 'candidate',
          model: 'provider/model',
          promptVersion: 'main@1',
          skillVersions: {},
          toolPolicyVersion: 'tools@1',
          contextPolicyVersion: 'context@1',
        },
      ],
    });
    const [trialId] = await store.enqueueTrials({
      armId: created.armIds[0] ?? '',
      caseIds: ['case-lease'],
      attempts: 1,
      seed: 'fixed-seed',
    });
    expect(await store.startExperiment(created.experimentId)).toBe(true);
    const staleToken = randomUUID();
    await expect(
      store.claimTrial({
        trialId: trialId ?? '',
        workerId: 'lost-eval-worker',
        claimToken: staleToken,
        leaseMs: 1_000,
      }),
    ).resolves.toBeDefined();
    const firstSandbox = await store.getTrialSandboxDescriptor(trialId ?? '');

    now = new Date('2026-08-04T00:00:02.000Z');
    await expect(store.failExpiredTrials(created.experimentId)).resolves.toEqual([trialId]);
    await expect(
      store.settleTrial({
        trialId: trialId ?? '',
        claimToken: staleToken,
        status: 'succeeded',
        resultMetrics: { succeeded: true },
      }),
    ).resolves.toBe(false);
    const retryId = await store.retryTrial({ trialId: trialId ?? '', seed: 'fixed-seed' });
    expect(retryId).toBeDefined();
    const retrySandbox = await store.getTrialSandboxDescriptor(retryId ?? '');
    expect(retrySandbox?.trialId).toBe(retryId);
    expect(retrySandbox?.objectPrefix).not.toBe(firstSandbox?.objectPrefix);
    expect(retrySandbox?.kafkaConsumerGroup).not.toBe(firstSandbox?.kafkaConsumerGroup);

    const retryClaim = await store.claimTrial({
      trialId: retryId ?? '',
      workerId: 'replacement-eval-worker',
      claimToken: randomUUID(),
      leaseMs: 1_000,
    });
    expect(retryClaim).toBeDefined();
    await expect(
      store.settleTrial({
        trialId: retryId ?? '',
        claimToken: retryClaim?.claimToken ?? '',
        status: 'succeeded',
        resultMetrics: { succeeded: true },
      }),
    ).resolves.toBe(true);
    const trials = await connection.db
      .select({
        attempt: evalTrials.attempt,
        status: evalTrials.status,
        failure: evalTrials.failure,
      })
      .from(evalTrials)
      .where(eq(evalTrials.armId, created.armIds[0] ?? ''));
    expect(trials).toEqual(
      expect.arrayContaining([
        {
          attempt: 1,
          status: 'failed',
          failure: { code: 'worker_lease_expired', category: 'runtime' },
        },
        { attempt: 2, status: 'succeeded', failure: null },
      ]),
    );
  });

  it('claims concurrent pending Trials with PostgreSQL SKIP LOCKED', async () => {
    const store = new ExperimentStore(connection.db);
    const created = await store.createExperiment({
      name: `parallel-claim-${randomUUID()}`,
      datasetVersion: 'parallel@1',
      config: {},
      arms: [
        {
          name: 'baseline',
          model: 'provider/model',
          promptVersion: 'main@1',
          skillVersions: {},
          toolPolicyVersion: 'tools@1',
          contextPolicyVersion: 'context@1',
        },
      ],
    });
    await store.enqueueTrials({
      armId: created.armIds[0] ?? '',
      caseIds: ['case-a', 'case-b'],
      attempts: 1,
      seed: 'parallel-seed',
    });
    await expect(store.startExperiment(created.experimentId)).resolves.toBe(true);
    const [first, second] = await Promise.all([
      store.claimNextTrial({
        experimentId: created.experimentId,
        workerId: 'parallel-worker-1',
        claimToken: randomUUID(),
        leaseMs: 60_000,
      }),
      store.claimNextTrial({
        experimentId: created.experimentId,
        workerId: 'parallel-worker-2',
        claimToken: randomUUID(),
        leaseMs: 60_000,
      }),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.trialId).not.toBe(second?.trialId);
    expect(new Set([first?.workerId, second?.workerId])).toEqual(
      new Set(['parallel-worker-1', 'parallel-worker-2']),
    );
  });
});

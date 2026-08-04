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
    const created = await store.createExperiment({
      name: `routing-${randomUUID()}`,
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
    expect(await store.claimTrial(trialIds[0] ?? '')).toBe(true);
    expect(await store.claimTrial(trialIds[0] ?? '')).toBe(false);
    expect(
      await store.settleTrial({
        trialId: trialIds[0] ?? '',
        status: 'succeeded',
        resultMetrics: { succeeded: true, schemaValid: true },
        processMetrics: { duplicateSideEffects: 0 },
      }),
    ).toBe(true);
    expect(await store.claimTrial(trialIds[1] ?? '')).toBe(true);
    expect(
      await store.settleTrial({
        trialId: trialIds[1] ?? '',
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
});

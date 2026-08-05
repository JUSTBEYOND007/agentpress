import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createEvalSandboxDescriptor,
  runSandboxExperiment,
  type EvalTrialClaim,
  type EvalSandboxDescriptor,
} from '../src/index.js';

describe('sandbox Trial runner', () => {
  it('claims concurrently, keeps leases fenced, and settles structured container results', async () => {
    const claims = Array.from({ length: 4 }, (_, index) => makeClaim(index + 1));
    const descriptors = new Map(
      claims.map((claim) => [claim.trialId, descriptorFor(claim.trialId, claim.armId)]),
    );
    const settlements: { trialId: string; status: string }[] = [];
    const cleanups: string[] = [];
    let active = 0;
    let maxActive = 0;
    const execute = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ status: 'succeeded', resultMetrics: { exact: 1 } }),
        stderr: '',
      };
    });
    const store = fakeStore({
      claims,
      descriptors,
      settlements,
      complete: () => true,
    });
    const resources = {
      provision: (descriptor: EvalSandboxDescriptor) =>
        Promise.resolve({
          descriptor,
          cleanup: () => {
            cleanups.push(descriptor.trialId);
            return Promise.resolve();
          },
        }),
      cleanupAbandoned: () => Promise.resolve(),
    };

    const summary = await runSandboxExperiment({
      store,
      resources,
      experimentId: 'experiment',
      workerId: 'worker',
      cases: [{ id: 'case', command: () => ['sh'] }],
      arms: [
        { armId: 'arm-1', image: 'image@sha256:' + 'a'.repeat(64) },
        { armId: 'arm-2', image: 'image@sha256:' + 'b'.repeat(64) },
      ],
      concurrency: 2,
      leaseMs: 1_000,
      retrySeed: 'seed',
      maxAttemptsPerCase: 1,
      execute,
    });

    expect(summary).toMatchObject({
      claimed: 4,
      succeeded: 4,
      failed: 0,
      cancelled: 0,
      stale: 0,
      experimentCompleted: true,
    });
    expect(maxActive).toBe(2);
    expect(cleanups).toHaveLength(4);
    expect(settlements).toHaveLength(4);
  });

  it('cleans an expired attempt, retries with a fresh identity, and does not reuse its resources', async () => {
    const expired = makeClaim(1);
    const replacement = makeClaim(2);
    const descriptors = new Map([
      [expired.trialId, descriptorFor(expired.trialId, expired.armId)],
      [replacement.trialId, descriptorFor(replacement.trialId, replacement.armId)],
    ]);
    const abandoned: string[] = [];
    const provisioned: string[] = [];
    const settlements: { trialId: string; status: string }[] = [];
    let retried = false;
    const store = fakeStore({
      claims: [replacement],
      descriptors,
      settlements,
      complete: () => true,
      expired: [expired.trialId],
      retry: (trialId) => {
        expect(trialId).toBe(expired.trialId);
        retried = true;
        return Promise.resolve(replacement.trialId);
      },
    });
    const resources = {
      provision: (descriptor: EvalSandboxDescriptor) => {
        provisioned.push(descriptor.trialId);
        return Promise.resolve({ descriptor, cleanup: () => Promise.resolve() });
      },
      cleanupAbandoned: (descriptor: EvalSandboxDescriptor) => {
        abandoned.push(descriptor.trialId);
        return Promise.resolve();
      },
    };

    const summary = await runSandboxExperiment({
      store,
      resources,
      experimentId: 'experiment',
      workerId: 'worker',
      cases: [{ id: 'case', command: () => ['sh'] }],
      arms: [{ armId: replacement.armId, image: 'image@sha256:' + 'a'.repeat(64) }],
      concurrency: 1,
      leaseMs: 1_000,
      retrySeed: 'fixed-seed',
      maxAttemptsPerCase: 2,
      execute: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ status: 'succeeded' }),
          stderr: '',
        }),
    });

    expect(retried).toBe(true);
    expect(abandoned).toEqual([expired.trialId]);
    expect(provisioned).toEqual([replacement.trialId]);
    expect(summary).toMatchObject({ recovered: 1, retriesCreated: 1, succeeded: 1 });
    expect(settlements).toEqual([{ trialId: replacement.trialId, status: 'succeeded' }]);
  });

  it('cancels the persisted Experiment before settling an active sandbox', async () => {
    const claim = makeClaim(1);
    const descriptors = new Map([[claim.trialId, descriptorFor(claim.trialId, claim.armId)]]);
    const settlements: { trialId: string; status: string }[] = [];
    let cancelled = false;
    const store = fakeStore({
      claims: [claim],
      descriptors,
      settlements,
      complete: () => false,
      onCancel: () => {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const execute = async (
      _plan: Parameters<NonNullable<Parameters<typeof runSandboxExperiment>[0]['execute']>>[0],
      options?: { readonly signal?: AbortSignal },
    ) => {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      throw new Error('cancelled by test');
    };
    const resources = {
      provision: (descriptor: EvalSandboxDescriptor) =>
        Promise.resolve({ descriptor, cleanup: () => Promise.resolve() }),
      cleanupAbandoned: () => Promise.resolve(),
    };
    const run = runSandboxExperiment({
      store,
      resources,
      experimentId: 'experiment',
      workerId: 'worker',
      cases: [{ id: 'case', command: () => ['sh'] }],
      arms: [{ armId: claim.armId, image: 'image@sha256:' + 'a'.repeat(64) }],
      concurrency: 1,
      leaseMs: 1_000,
      retrySeed: 'seed',
      maxAttemptsPerCase: 3,
      signal: controller.signal,
      execute,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const summary = await run;

    expect(cancelled).toBe(true);
    expect(summary).toMatchObject({ claimed: 1, cancelled: 1, retriesCreated: 0 });
    expect(settlements).toEqual([{ trialId: claim.trialId, status: 'cancelled' }]);
  });
});

function makeClaim(attempt: number): EvalTrialClaim {
  return {
    trialId: randomUUID(),
    armId: attempt % 2 === 0 ? 'arm-2' : 'arm-1',
    caseId: 'case',
    attempt,
    seed: `seed:case:${String(attempt)}`,
    claimToken: randomUUID(),
    workerId: `worker:${String(attempt)}`,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
}

function descriptorFor(trialId: string, armId: string): EvalSandboxDescriptor {
  return createEvalSandboxDescriptor({ experimentId: 'experiment', armId, trialId });
}

function fakeStore(input: {
  readonly claims: EvalTrialClaim[];
  readonly descriptors: ReadonlyMap<string, EvalSandboxDescriptor>;
  readonly settlements: { trialId: string; status: string }[];
  readonly complete: () => boolean;
  readonly expired?: readonly string[];
  readonly retry?: (trialId: string) => Promise<string | undefined>;
  readonly onCancel?: () => void;
}) {
  const claims = [...input.claims];
  return {
    cancelExperiment: () => {
      input.onCancel?.();
      return Promise.resolve(true);
    },
    claimNextTrial: () => Promise.resolve(claims.shift()),
    completeExperimentIfSettled: () => Promise.resolve(input.complete()),
    failExpiredTrials: () => Promise.resolve(input.expired ?? []),
    getTrialSandboxDescriptor: (trialId: string) => Promise.resolve(input.descriptors.get(trialId)),
    renewTrialLease: () => Promise.resolve(true),
    retryTrial: ({ trialId }: { trialId: string }) =>
      input.retry ? input.retry(trialId) : Promise.resolve(undefined),
    settleTrial: ({ trialId, status }: { trialId: string; status: string }) => {
      input.settlements.push({ trialId, status });
      return Promise.resolve(true);
    },
  };
}

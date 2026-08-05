import { randomUUID } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  createDockerEvalSandboxPlan,
  type DockerEvalSandboxLimits,
} from './docker-sandbox-plan.js';
import {
  DockerEvalSandboxExecutionError,
  executeDockerEvalSandbox,
  type DockerEvalSandboxResult,
} from './docker-sandbox-runner.js';
import { type EvalTrialClaim, ExperimentStore } from './experiment-store.js';
import type { EvalSandboxDescriptor } from './sandbox-policy.js';
import type { EvalSandboxResources } from './sandbox-resources.js';

const MetricsSchema = Type.Record(Type.String({ minLength: 1, maxLength: 200 }), Type.Unknown());
const SandboxTrialOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
    resultMetrics: Type.Optional(MetricsSchema),
    processMetrics: Type.Optional(MetricsSchema),
    failure: Type.Optional(MetricsSchema),
  },
  { additionalProperties: false },
);

type TrialSettlement = {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly resultMetrics?: Readonly<Record<string, unknown>>;
  readonly processMetrics?: Readonly<Record<string, unknown>>;
  readonly failure?: Readonly<Record<string, unknown>>;
};

export type SandboxTrialContext = {
  readonly claim: EvalTrialClaim;
  readonly descriptor: EvalSandboxDescriptor;
};

export type SandboxTrialCase = {
  readonly id: string;
  readonly command: (context: SandboxTrialContext) => readonly string[];
};

export type SandboxTrialArm = {
  readonly armId: string;
  readonly image: string;
};

export type SandboxExperimentRunSummary = {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly stale: number;
  readonly recovered: number;
  readonly retriesCreated: number;
  readonly experimentCompleted: boolean;
};

type SandboxTrialStore = Pick<
  ExperimentStore,
  | 'cancelExperiment'
  | 'claimNextTrial'
  | 'completeExperimentIfSettled'
  | 'failExpiredTrials'
  | 'getTrialSandboxDescriptor'
  | 'renewTrialLease'
  | 'retryTrial'
  | 'settleTrial'
>;

export async function runSandboxExperiment(input: {
  readonly store: SandboxTrialStore;
  readonly resources: EvalSandboxResources;
  readonly experimentId: string;
  readonly workerId: string;
  readonly cases: readonly SandboxTrialCase[];
  readonly arms: readonly SandboxTrialArm[];
  readonly concurrency: number;
  readonly leaseMs: number;
  readonly retrySeed: string;
  readonly maxAttemptsPerCase: number;
  readonly limits?: Partial<DockerEvalSandboxLimits>;
  readonly signal?: AbortSignal;
  readonly execute?: typeof executeDockerEvalSandbox;
}): Promise<SandboxExperimentRunSummary> {
  validateRunInput(input);
  const cases = uniqueMap(input.cases, ({ id }) => id, 'case');
  const arms = uniqueMap(input.arms, ({ armId }) => armId, 'arm');
  const execute = input.execute ?? executeDockerEvalSandbox;
  const counters = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    stale: 0,
    recovered: 0,
    retriesCreated: 0,
  };
  let cancellation: Promise<boolean> | undefined;
  const cancel = (): void => {
    cancellation ??= input.store.cancelExperiment(input.experimentId);
  };
  input.signal?.addEventListener('abort', cancel, { once: true });
  if (input.signal?.aborted) cancel();

  try {
    if (!input.signal?.aborted) {
      const expired = await input.store.failExpiredTrials(input.experimentId);
      for (const trialId of expired) {
        const descriptor = await input.store.getTrialSandboxDescriptor(trialId);
        if (!descriptor) throw new Error('Expired evaluation Trial has no sandbox descriptor');
        await input.resources.cleanupAbandoned(descriptor);
        counters.recovered += 1;
        const retryId = await input.store.retryTrial({
          trialId,
          seed: input.retrySeed,
          maxAttempt: input.maxAttemptsPerCase,
        });
        if (retryId) counters.retriesCreated += 1;
      }
    }

    const worker = async (workerIndex: number): Promise<void> => {
      while (!input.signal?.aborted) {
        const claim = await input.store.claimNextTrial({
          experimentId: input.experimentId,
          workerId: `${input.workerId}:${String(workerIndex)}`,
          claimToken: randomUUID(),
          leaseMs: input.leaseMs,
        });
        if (!claim) return;
        counters.claimed += 1;
        const result = await executeClaim({
          claim,
          store: input.store,
          resources: input.resources,
          trialCase: cases.get(claim.caseId),
          arm: arms.get(claim.armId),
          limits: input.limits,
          leaseMs: input.leaseMs,
          signal: input.signal,
          execute,
          waitForCancellation: async () => {
            if (cancellation) await cancellation;
          },
        });
        counters[result.status] += 1;
        if (
          result.settled &&
          result.status === 'failed' &&
          claim.attempt < input.maxAttemptsPerCase
        ) {
          const retryId = await input.store.retryTrial({
            trialId: claim.trialId,
            seed: input.retrySeed,
            maxAttempt: input.maxAttemptsPerCase,
          });
          if (retryId) counters.retriesCreated += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: input.concurrency }, (_, index) => worker(index + 1)));
    if (cancellation) await cancellation;
    const experimentCompleted = input.signal?.aborted
      ? false
      : await input.store.completeExperimentIfSettled(input.experimentId);
    return { ...counters, experimentCompleted };
  } finally {
    input.signal?.removeEventListener('abort', cancel);
  }
}

async function executeClaim(input: {
  readonly claim: EvalTrialClaim;
  readonly store: SandboxTrialStore;
  readonly resources: EvalSandboxResources;
  readonly trialCase: SandboxTrialCase | undefined;
  readonly arm: SandboxTrialArm | undefined;
  readonly limits: Partial<DockerEvalSandboxLimits> | undefined;
  readonly leaseMs: number;
  readonly signal: AbortSignal | undefined;
  readonly execute: typeof executeDockerEvalSandbox;
  readonly waitForCancellation: () => Promise<void>;
}): Promise<{
  readonly status: keyof Pick<
    SandboxExperimentRunSummary,
    'succeeded' | 'failed' | 'cancelled' | 'stale'
  >;
  readonly settled: boolean;
}> {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const heartbeat = startHeartbeat(input.store, input.claim, input.leaseMs, controller);
  let resourceLease: Awaited<ReturnType<EvalSandboxResources['provision']>> | undefined;
  let settlement: TrialSettlement;
  try {
    if (!input.trialCase) throw new Error(`Unknown evaluation case: ${input.claim.caseId}`);
    if (!input.arm) throw new Error(`Unknown evaluation arm: ${input.claim.armId}`);
    const descriptor = await input.store.getTrialSandboxDescriptor(input.claim.trialId);
    if (!descriptor) throw new Error('Claimed evaluation Trial has no sandbox descriptor');
    resourceLease = await input.resources.provision(descriptor);
    const command = input.trialCase.command({ claim: input.claim, descriptor });
    const result = await input.execute(
      createDockerEvalSandboxPlan({
        descriptor,
        image: input.arm.image,
        command,
        ...(input.limits ? { limits: input.limits } : {}),
      }),
      { signal: controller.signal },
    );
    settlement = parseOutput(result);
  } catch (error) {
    settlement = failureSettlement(error, input.signal?.aborted === true, heartbeat.lost());
  }

  if (resourceLease) {
    try {
      await resourceLease.cleanup();
    } catch (error) {
      settlement = failureSettlement(error, false, false, 'sandbox_cleanup_failed');
    }
  }
  await heartbeat.stop();
  input.signal?.removeEventListener('abort', abort);
  if (input.signal?.aborted) await input.waitForCancellation();
  const settled = await input.store.settleTrial({
    trialId: input.claim.trialId,
    claimToken: input.claim.claimToken,
    ...settlement,
  });
  return {
    status: settled ? settlement.status : input.signal?.aborted ? 'cancelled' : 'stale',
    settled,
  };
}

function startHeartbeat(
  store: SandboxTrialStore,
  claim: EvalTrialClaim,
  leaseMs: number,
  controller: AbortController,
): { readonly lost: () => boolean; readonly stop: () => Promise<void> } {
  let lost = false;
  let renewal: Promise<void> | undefined;
  const renew = (): void => {
    if (renewal) return;
    renewal = store
      .renewTrialLease({ trialId: claim.trialId, claimToken: claim.claimToken, leaseMs })
      .then((renewed) => {
        if (!renewed) {
          lost = true;
          controller.abort();
        }
      })
      .catch(() => {
        lost = true;
        controller.abort();
      })
      .finally(() => {
        renewal = undefined;
      });
  };
  const timer = setInterval(renew, Math.max(250, Math.floor(leaseMs / 3)));
  timer.unref();
  return {
    lost: () => lost,
    stop: async () => {
      clearInterval(timer);
      await renewal;
    },
  };
}

function parseOutput(result: DockerEvalSandboxResult): TrialSettlement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    throw new Error('Evaluation sandbox output is not valid JSON');
  }
  if (!Value.Check(SandboxTrialOutputSchema, parsed)) {
    throw new Error('Evaluation sandbox output does not match the Trial result contract');
  }
  const output = parsed;
  if (output.status === 'failed' && !output.failure) {
    throw new Error('Failed evaluation sandbox output requires a failure object');
  }
  if (output.status === 'succeeded' && output.failure) {
    throw new Error('Successful evaluation sandbox output cannot include failure');
  }
  return output;
}

function failureSettlement(
  error: unknown,
  cancelled: boolean,
  claimLost: boolean,
  overrideCode?: string,
): TrialSettlement {
  if (cancelled) return { status: 'cancelled' };
  const code =
    overrideCode ??
    (claimLost
      ? 'claim_lost'
      : error instanceof DockerEvalSandboxExecutionError
        ? `sandbox_${error.reason}`
        : 'sandbox_execution_failed');
  return {
    status: 'failed',
    failure: {
      code,
      category: 'runtime',
      message: error instanceof Error ? error.message.slice(0, 500) : 'Unknown sandbox failure',
    },
  };
}

function validateRunInput(input: {
  readonly experimentId: string;
  readonly workerId: string;
  readonly concurrency: number;
  readonly leaseMs: number;
  readonly retrySeed: string;
  readonly maxAttemptsPerCase: number;
}): void {
  if (!input.experimentId.trim() || !input.workerId.trim() || !input.retrySeed.trim()) {
    throw new TypeError('Sandbox experiment runner identity is invalid');
  }
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 16) {
    throw new RangeError('Sandbox experiment concurrency must be between 1 and 16');
  }
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 3_600_000) {
    throw new RangeError('Sandbox experiment lease must be between 1000 and 3600000 ms');
  }
  if (
    !Number.isSafeInteger(input.maxAttemptsPerCase) ||
    input.maxAttemptsPerCase < 1 ||
    input.maxAttemptsPerCase > 20
  ) {
    throw new RangeError('Sandbox experiment max attempts must be between 1 and 20');
  }
}

function uniqueMap<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (!identity.trim() || result.has(identity)) {
      throw new Error(`Sandbox experiment ${label} identities must be unique and non-empty`);
    }
    result.set(identity, value);
  }
  if (result.size === 0) throw new Error(`Sandbox experiment requires at least one ${label}`);
  return result;
}

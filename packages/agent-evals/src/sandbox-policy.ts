import { createHash } from 'node:crypto';

export type EvalSandboxNetworkPolicy = {
  readonly mode: 'deny-by-default';
  readonly allowedHosts: readonly string[];
};

export type EvalSandboxDescriptor = {
  readonly experimentId: string;
  readonly armId: string;
  readonly trialId: string;
  readonly databaseSchema: string;
  readonly objectPrefix: string;
  readonly kafkaTopic: string;
  readonly kafkaConsumerGroup: string;
  readonly network: EvalSandboxNetworkPolicy;
};

export type EvalSandboxPolicyInput = {
  readonly experimentId: string;
  readonly armId: string;
  readonly trialId: string;
  readonly allowedHosts?: readonly string[];
};

/**
 * Derives every external resource identity from immutable trial facts.
 * Callers cannot inject a shared schema/prefix/topic or silently widen egress.
 */
export function createEvalSandboxDescriptor(input: EvalSandboxPolicyInput): EvalSandboxDescriptor {
  validateIdentity(input.experimentId, 'experimentId');
  validateIdentity(input.armId, 'armId');
  validateIdentity(input.trialId, 'trialId');
  const experiment = resourceToken(input.experimentId);
  const arm = resourceToken(input.armId);
  const trial = resourceToken(input.trialId);
  const databaseScope = resourceToken(
    `${input.experimentId}\u0000${input.armId}\u0000${input.trialId}`,
  );
  const allowedHosts = normalizeHosts(input.allowedHosts ?? []);
  return {
    experimentId: input.experimentId,
    armId: input.armId,
    trialId: input.trialId,
    databaseSchema: `eval_${databaseScope}`,
    objectPrefix: `eval/${experiment}/${arm}/${trial}/`,
    kafkaTopic: `eval.${experiment}.${trial}.trials`,
    kafkaConsumerGroup: `eval.${experiment}.${arm}.${trial}`,
    network: { mode: 'deny-by-default', allowedHosts },
  };
}

/** Rejects a descriptor that is not the deterministic scope for this trial. */
export function assertEvalSandboxDescriptor(
  descriptor: EvalSandboxDescriptor,
  input: EvalSandboxPolicyInput,
): void {
  const expected = createEvalSandboxDescriptor(input);
  if (JSON.stringify(descriptor) !== JSON.stringify(expected)) {
    throw new Error('Evaluation sandbox descriptor does not match the immutable trial scope');
  }
}

function validateIdentity(value: string, label: string): void {
  if (!value.trim() || value.length > 160 || hasControlCharacter(value)) {
    throw new TypeError(`Evaluation ${label} is invalid`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function resourceToken(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function normalizeHosts(hosts: readonly string[]): readonly string[] {
  const normalized = [...new Set(hosts.map((host) => host.trim().toLowerCase()))].sort();
  if (normalized.length > 16 || normalized.some((host) => !isSafeHost(host))) {
    throw new Error('Evaluation sandbox network allowlist is invalid');
  }
  return normalized;
}

function isSafeHost(host: string): boolean {
  if (!host || host.length > 253 || host.includes('/') || host.includes('\\')) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.)/u.test(host)) return false;
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/u.test(host);
}

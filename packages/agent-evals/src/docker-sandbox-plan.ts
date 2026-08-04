import { createHash } from 'node:crypto';

import { assertEvalSandboxDescriptor, type EvalSandboxDescriptor } from './sandbox-policy.js';

export type DockerEvalSandboxLimits = {
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pids: number;
  readonly timeoutSeconds: number;
  readonly temporaryStorageMb: number;
};

export type DockerEvalSandboxPlan = {
  readonly executable: 'docker';
  readonly arguments: readonly string[];
  readonly containerName: string;
  readonly timeoutMs: number;
};

const defaultLimits: DockerEvalSandboxLimits = {
  cpus: 2,
  memoryMb: 2_048,
  pids: 256,
  timeoutSeconds: 900,
  temporaryStorageMb: 256,
};

/**
 * Produces a fail-closed Docker invocation. Non-empty egress allowlists need a
 * separately audited proxy and therefore cannot silently degrade to open networking.
 */
export function createDockerEvalSandboxPlan(input: {
  readonly descriptor: EvalSandboxDescriptor;
  readonly image: string;
  readonly command: readonly string[];
  readonly limits?: Partial<DockerEvalSandboxLimits>;
}): DockerEvalSandboxPlan {
  assertEvalSandboxDescriptor(input.descriptor, {
    experimentId: input.descriptor.experimentId,
    armId: input.descriptor.armId,
    trialId: input.descriptor.trialId,
    allowedHosts: input.descriptor.network.allowedHosts,
  });
  assertImmutableImage(input.image);
  assertCommand(input.command);
  if (input.descriptor.network.allowedHosts.length > 0) {
    throw new Error('Evaluation sandbox egress requires an audited allowlist proxy');
  }
  const limits = normalizeLimits(input.limits);
  const containerName = `agentpress-eval-${token(input.descriptor.trialId)}`;
  const labels = [
    `agentpress.eval.experiment=${token(input.descriptor.experimentId)}`,
    `agentpress.eval.arm=${token(input.descriptor.armId)}`,
    `agentpress.eval.trial=${token(input.descriptor.trialId)}`,
  ];
  const environment = [
    `AGENTPRESS_EVAL_DATABASE_SCHEMA=${input.descriptor.databaseSchema}`,
    `AGENTPRESS_EVAL_OBJECT_PREFIX=${input.descriptor.objectPrefix}`,
    `AGENTPRESS_EVAL_KAFKA_TOPIC=${input.descriptor.kafkaTopic}`,
    `AGENTPRESS_EVAL_KAFKA_GROUP=${input.descriptor.kafkaConsumerGroup}`,
  ];
  return {
    executable: 'docker',
    containerName,
    timeoutMs: limits.timeoutSeconds * 1_000,
    arguments: [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network',
      'none',
      '--read-only',
      '--user',
      '65532:65532',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--pids-limit',
      String(limits.pids),
      '--cpus',
      String(limits.cpus),
      '--memory',
      `${String(limits.memoryMb)}m`,
      '--memory-swap',
      `${String(limits.memoryMb)}m`,
      '--tmpfs',
      `/tmp:rw,noexec,nosuid,nodev,size=${String(limits.temporaryStorageMb)}m`,
      ...labels.flatMap((label) => ['--label', label]),
      ...environment.flatMap((value) => ['--env', value]),
      input.image,
      ...input.command,
    ],
  };
}

function assertImmutableImage(image: string): void {
  if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new Error('Evaluation sandbox image must be pinned by sha256 digest');
  }
}

function assertCommand(command: readonly string[]): void {
  if (
    command.length === 0 ||
    command.length > 64 ||
    command.some(
      (part) =>
        !part ||
        part.length > 4_096 ||
        part.includes('\u0000') ||
        part.includes('\n') ||
        part.includes('\r'),
    )
  ) {
    throw new Error('Evaluation sandbox command is invalid');
  }
}

function normalizeLimits(
  overrides: Partial<DockerEvalSandboxLimits> | undefined,
): DockerEvalSandboxLimits {
  const limits = { ...defaultLimits, ...overrides };
  if (!Number.isFinite(limits.cpus) || limits.cpus <= 0 || limits.cpus > 16) {
    throw new Error('Evaluation sandbox CPU limit must be between zero and 16');
  }
  integerLimit(limits.memoryMb, 128, 32_768, 'memory');
  integerLimit(limits.pids, 16, 4_096, 'PID');
  integerLimit(limits.timeoutSeconds, 1, 7_200, 'timeout');
  integerLimit(limits.temporaryStorageMb, 16, 4_096, 'temporary storage');
  return limits;
}

function integerLimit(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Evaluation sandbox ${label} limit must be between ${String(minimum)} and ${String(maximum)}`,
    );
  }
}

function token(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

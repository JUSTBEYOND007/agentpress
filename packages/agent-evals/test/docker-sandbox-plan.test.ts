import { describe, expect, it } from 'vitest';

import { createDockerEvalSandboxPlan, createEvalSandboxDescriptor } from '../src/index.js';

const digest = `registry.example/agentpress-eval@sha256:${'a'.repeat(64)}`;

describe('Docker evaluation sandbox plan', () => {
  it('pins identities into a networkless, non-root and resource-bounded container', () => {
    const descriptor = createEvalSandboxDescriptor({
      experimentId: 'experiment-1',
      armId: 'arm-1',
      trialId: 'trial-1',
    });
    const plan = createDockerEvalSandboxPlan({
      descriptor,
      image: digest,
      command: ['node', 'dist/eval-worker.js'],
    });

    expect(plan.executable).toBe('docker');
    expect(plan.timeoutMs).toBe(900_000);
    expect(plan.arguments).toEqual(
      expect.arrayContaining([
        '--network',
        'none',
        '--read-only',
        '--user',
        '65532:65532',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges=true',
        '--memory-swap',
        '2048m',
        `AGENTPRESS_EVAL_DATABASE_SCHEMA=${descriptor.databaseSchema}`,
        `AGENTPRESS_EVAL_OBJECT_PREFIX=${descriptor.objectPrefix}`,
        `AGENTPRESS_EVAL_KAFKA_TOPIC=${descriptor.kafkaTopic}`,
        `AGENTPRESS_EVAL_KAFKA_GROUP=${descriptor.kafkaConsumerGroup}`,
        digest,
      ]),
    );
    expect(plan.arguments).not.toContain('--volume');
    expect(plan.arguments).not.toContain('--privileged');
  });

  it('rejects mutable images, open egress and unsafe commands', () => {
    const descriptor = createEvalSandboxDescriptor({
      experimentId: 'experiment-1',
      armId: 'arm-1',
      trialId: 'trial-1',
    });
    expect(() =>
      createDockerEvalSandboxPlan({
        descriptor,
        image: 'agentpress-eval:latest',
        command: ['node'],
      }),
    ).toThrow(/sha256 digest/u);
    expect(() =>
      createDockerEvalSandboxPlan({
        descriptor: createEvalSandboxDescriptor({
          experimentId: 'experiment-1',
          armId: 'arm-1',
          trialId: 'trial-1',
          allowedHosts: ['api.example.com'],
        }),
        image: digest,
        command: ['node'],
      }),
    ).toThrow(/allowlist proxy/u);
    expect(() =>
      createDockerEvalSandboxPlan({ descriptor, image: digest, command: ['node\n--escape'] }),
    ).toThrow(/command is invalid/u);
  });
});

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { connectDatabase, evalExperiments, evalTrials } from '@agentpress/database';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Kafka, logLevel } from 'kafkajs';
import { Client } from 'minio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDockerEvalSandboxPlan,
  createEvalSandboxDescriptor,
  EvalSandboxResourceManager,
  type EvalSandboxDescriptor,
  executeDockerEvalSandbox,
  ExperimentStore,
  MinioEvalSandboxObjectPrefixStore,
  runSandboxExperiment,
  type EvalSandboxResourceLease,
} from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const brokers = process.env.KAFKA_BROKERS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const s3Endpoint = process.env.S3_ENDPOINT;
const requiredInfrastructure = databaseUrl && brokers?.length && s3Endpoint;
const describeWithInfrastructure = requiredInfrastructure ? describe : describe.skip;
const alpineImage =
  process.env.AGENTPRESS_EVAL_TEST_IMAGE ??
  'alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b';

describeWithInfrastructure('real evaluation sandbox infrastructure', () => {
  const connection = connectDatabase(databaseUrl ?? '');
  const kafka = new Kafka({
    brokers: brokers ?? [],
    clientId: `eval-sandbox-integration-${randomUUID()}`,
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  const endpoint = new URL(s3Endpoint ?? 'http://localhost:9000');
  const bucket = process.env.S3_BUCKET ?? 'agentpress';
  const minio = new Client({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80')),
    useSSL: endpoint.protocol === 'https:',
    accessKey: process.env.S3_ACCESS_KEY ?? 'agentpress',
    secretKey: process.env.S3_SECRET_KEY ?? 'agentpress-local-secret',
  });
  const objectPrefixes = new MinioEvalSandboxObjectPrefixStore(minio, bucket);
  const manager = new EvalSandboxResourceManager(connection.db, admin, objectPrefixes);
  const suffix = randomUUID();
  const descriptor = createEvalSandboxDescriptor({
    experimentId: `experiment-${suffix}`,
    armId: `arm-${suffix}`,
    trialId: `trial-${suffix}`,
  });
  let lease: EvalSandboxResourceLease | undefined;

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await admin.connect();
    if (!(await minio.bucketExists(bucket))) {
      throw new Error(`Evaluation sandbox bucket does not exist: ${bucket}`);
    }
  });

  afterAll(async () => {
    await lease?.cleanup().catch(() => undefined);
    await admin.disconnect();
    await connection.close();
  });

  it('provisions isolated resources, enforces the Docker namespace, and removes every resource', async () => {
    lease = await manager.provision(descriptor);
    await expect(schemaExists()).resolves.toBe(true);
    await expect(admin.listTopics()).resolves.toContain(descriptor.kafkaTopic);
    await expect(listPrefix()).resolves.toEqual([`${descriptor.objectPrefix}.agentpress-sandbox`]);

    const plan = createDockerEvalSandboxPlan({
      descriptor,
      image: alpineImage,
      command: [
        'sh',
        '-ec',
        [
          'test "$(id -u)" = 65532',
          'touch /tmp/write-ok',
          '! touch /read-only-probe 2>/dev/null',
          'printf "#!/bin/sh\\nexit 0\\n" > /tmp/noexec-probe',
          'chmod +x /tmp/noexec-probe',
          '! /tmp/noexec-probe 2>/dev/null',
          'test "$(awk \'/^NoNewPrivs:/ {print $2}\' /proc/self/status)" = 1',
          'test "$(awk \'/^CapEff:/ {print $2}\' /proc/self/status)" = 0000000000000000',
          'test ! -e /sys/class/net/eth0',
          'printf "%s\\n" "$AGENTPRESS_EVAL_DATABASE_SCHEMA" "$AGENTPRESS_EVAL_OBJECT_PREFIX" "$AGENTPRESS_EVAL_KAFKA_TOPIC" "$AGENTPRESS_EVAL_KAFKA_GROUP"',
        ].join('; '),
      ],
      limits: { timeoutSeconds: 15 },
    });
    const result = await executeDockerEvalSandbox(plan);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      descriptor.databaseSchema,
      descriptor.objectPrefix,
      descriptor.kafkaTopic,
      descriptor.kafkaConsumerGroup,
    ]);

    await lease.cleanup();
    await expect(schemaExists()).resolves.toBe(false);
    await expect(waitForTopicDeletion()).resolves.toBeUndefined();
    await expect(listPrefix()).resolves.toEqual([]);
    lease = undefined;
  }, 30_000);

  it('force-removes a container when its bounded execution times out', async () => {
    const plan = createDockerEvalSandboxPlan({
      descriptor,
      image: alpineImage,
      command: ['sleep', '30'],
      limits: { timeoutSeconds: 1 },
    });

    await expect(executeDockerEvalSandbox(plan)).rejects.toMatchObject({ reason: 'timeout' });
    await expect(containerNames(plan.containerName)).resolves.toBe('');
  }, 15_000);

  it('force-removes a container when its output exceeds the host boundary', async () => {
    const plan = createDockerEvalSandboxPlan({
      descriptor,
      image: alpineImage,
      command: ['sh', '-c', 'while true; do echo 0123456789; done'],
      limits: { timeoutSeconds: 10 },
    });

    await expect(executeDockerEvalSandbox(plan, { maxOutputBytes: 128 })).rejects.toMatchObject({
      reason: 'output_limit',
    });
    await expect(containerNames(plan.containerName)).resolves.toBe('');
  }, 15_000);

  it('runs a persisted Trial, retries into fresh resources, and completes the Experiment', async () => {
    const store = new ExperimentStore(connection.db);
    const created = await store.createExperiment({
      name: `sandbox-runner-${suffix}`,
      datasetVersion: 'sandbox@1',
      config: { execution: 'docker' },
      arms: [
        {
          name: 'alpine',
          model: alpineImage,
          promptVersion: 'sandbox@1',
          skillVersions: {},
          toolPolicyVersion: 'sandbox@1',
          contextPolicyVersion: 'sandbox@1',
        },
      ],
    });
    await store.enqueueTrials({
      armId: created.armIds[0] ?? '',
      caseIds: ['structured-result'],
      attempts: 1,
      seed: 'sandbox-seed',
    });
    await expect(store.startExperiment(created.experimentId)).resolves.toBe(true);

    const summary = await runSandboxExperiment({
      store,
      resources: manager,
      experimentId: created.experimentId,
      workerId: `sandbox-runner-${suffix}`,
      cases: [
        {
          id: 'structured-result',
          command: ({ claim }) => {
            const output =
              claim.attempt === 1
                ? { status: 'failed', failure: { code: 'synthetic_case_failure' } }
                : { status: 'succeeded', resultMetrics: { recovered: true } };
            const serialized = JSON.stringify(output);
            return ['sh', '-ec', `printf '%s' '${serialized}'`];
          },
        },
      ],
      arms: [{ armId: created.armIds[0] ?? '', image: alpineImage }],
      concurrency: 1,
      leaseMs: 1_000,
      retrySeed: 'sandbox-seed',
      maxAttemptsPerCase: 2,
      limits: { timeoutSeconds: 15 },
    });

    expect(summary).toMatchObject({
      claimed: 2,
      failed: 1,
      succeeded: 1,
      retriesCreated: 1,
      experimentCompleted: true,
    });
    const trials = await connection.db
      .select({ id: evalTrials.id, attempt: evalTrials.attempt, status: evalTrials.status })
      .from(evalTrials)
      .where(sql`${evalTrials.armId} = ${created.armIds[0]}`)
      .orderBy(evalTrials.attempt);
    expect(trials).toEqual([
      expect.objectContaining({ attempt: 1, status: 'failed' }),
      expect.objectContaining({ attempt: 2, status: 'succeeded' }),
    ]);
    const firstDescriptor = await store.getTrialSandboxDescriptor(trials[0]?.id ?? '');
    const retryDescriptor = await store.getTrialSandboxDescriptor(trials[1]?.id ?? '');
    expect(firstDescriptor?.databaseSchema).not.toBe(retryDescriptor?.databaseSchema);
    expect(firstDescriptor?.kafkaTopic).not.toBe(retryDescriptor?.kafkaTopic);
    expect(firstDescriptor?.objectPrefix).not.toBe(retryDescriptor?.objectPrefix);
    await expect(
      connection.db
        .select({ status: evalExperiments.status })
        .from(evalExperiments)
        .where(sql`${evalExperiments.id} = ${created.experimentId}`),
    ).resolves.toEqual([{ status: 'completed' }]);
    await expect(schemaExistsFor(firstDescriptor)).resolves.toBe(false);
    await expect(schemaExistsFor(retryDescriptor)).resolves.toBe(false);
    await expect(admin.listTopics()).resolves.not.toEqual(
      expect.arrayContaining([firstDescriptor?.kafkaTopic, retryDescriptor?.kafkaTopic]),
    );
    await expect(listPrefixFor(firstDescriptor)).resolves.toEqual([]);
    await expect(listPrefixFor(retryDescriptor)).resolves.toEqual([]);
  }, 40_000);

  async function containerNames(containerName: string): Promise<string> {
    const { stdout } = await promisify(execFile)('docker', [
      'ps',
      '--all',
      '--filter',
      `name=^/${containerName}$`,
      '--format',
      '{{.Names}}',
    ]);
    return stdout.trim();
  }

  async function schemaExists(): Promise<boolean> {
    return schemaExistsFor(descriptor);
  }

  async function schemaExistsFor(value: EvalSandboxDescriptor | undefined): Promise<boolean> {
    if (!value) return false;
    const result = await connection.db.execute(sql`
      select exists(
        select 1 from information_schema.schemata
        where schema_name = ${value.databaseSchema}
      ) as exists
    `);
    const row: unknown = result.rows[0];
    return Boolean(row && typeof row === 'object' && 'exists' in row && row.exists === true);
  }

  async function listPrefix(): Promise<string[]> {
    return listPrefixFor(descriptor);
  }

  async function listPrefixFor(value: EvalSandboxDescriptor | undefined): Promise<string[]> {
    if (!value) return [];
    const names: string[] = [];
    for await (const item of minio.listObjectsV2(bucket, value.objectPrefix, true)) {
      const value: unknown = item;
      if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
        names.push(value.name);
      }
    }
    return names;
  }

  async function waitForTopicDeletion(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!(await admin.listTopics()).includes(descriptor.kafkaTopic)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for evaluation Kafka topic cleanup');
  }
});

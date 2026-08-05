import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { connectDatabase } from '@agentpress/database';
import { sql } from 'drizzle-orm';
import { Kafka, logLevel } from 'kafkajs';
import { Client } from 'minio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDockerEvalSandboxPlan,
  createEvalSandboxDescriptor,
  EvalSandboxResourceManager,
  executeDockerEvalSandbox,
  MinioEvalSandboxObjectPrefixStore,
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
    const result = await connection.db.execute(sql`
      select exists(
        select 1 from information_schema.schemata
        where schema_name = ${descriptor.databaseSchema}
      ) as exists
    `);
    const row: unknown = result.rows[0];
    return Boolean(row && typeof row === 'object' && 'exists' in row && row.exists === true);
  }

  async function listPrefix(): Promise<string[]> {
    const names: string[] = [];
    for await (const item of minio.listObjectsV2(bucket, descriptor.objectPrefix, true)) {
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

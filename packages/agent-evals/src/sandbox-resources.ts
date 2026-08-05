import type { AgentPressDatabase } from '@agentpress/database';
import { sql } from 'drizzle-orm';
import type { Admin } from 'kafkajs';
import type { Client } from 'minio';

import { assertEvalSandboxDescriptor, type EvalSandboxDescriptor } from './sandbox-policy.js';

const markerName = '.agentpress-sandbox';

export type EvalSandboxObjectPrefixStore = {
  reserve(prefix: string): Promise<void>;
  clear(prefix: string): Promise<void>;
};

export type EvalSandboxResourceLease = {
  readonly descriptor: EvalSandboxDescriptor;
  cleanup(): Promise<void>;
};

export type EvalSandboxResources = {
  provision(descriptor: EvalSandboxDescriptor): Promise<EvalSandboxResourceLease>;
  cleanupAbandoned(descriptor: EvalSandboxDescriptor): Promise<void>;
};

export class MinioEvalSandboxObjectPrefixStore implements EvalSandboxObjectPrefixStore {
  public constructor(
    private readonly client: Client,
    private readonly bucket: string,
  ) {
    if (!bucket.trim()) throw new TypeError('Evaluation sandbox object bucket is required');
  }

  public async reserve(prefix: string): Promise<void> {
    assertObjectPrefix(prefix);
    for await (const item of this.client.listObjectsV2(this.bucket, prefix, true)) {
      if (readObjectName(item as unknown)) {
        throw new Error('Evaluation sandbox object prefix is already in use');
      }
    }
    await this.client.putObject(this.bucket, `${prefix}${markerName}`, Buffer.alloc(0), 0, {
      'content-type': 'application/octet-stream',
    });
  }

  public async clear(prefix: string): Promise<void> {
    assertObjectPrefix(prefix);
    const names: string[] = [];
    for await (const item of this.client.listObjectsV2(this.bucket, prefix, true)) {
      const name = readObjectName(item as unknown);
      if (name) names.push(name);
      if (names.length === 1_000) {
        await this.client.removeObjects(this.bucket, names.splice(0));
      }
    }
    if (names.length > 0) await this.client.removeObjects(this.bucket, names);
  }
}

export class EvalSandboxResourceManager {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly kafka: Admin,
    private readonly objects: EvalSandboxObjectPrefixStore,
  ) {}

  public async provision(descriptor: EvalSandboxDescriptor): Promise<EvalSandboxResourceLease> {
    assertDescriptor(descriptor);
    let schemaCreated = false;
    let topicCreated = false;
    let objectPrefixReserved = false;
    try {
      await this.database.execute(sql`create schema ${sql.identifier(descriptor.databaseSchema)}`);
      schemaCreated = true;
      topicCreated = await this.kafka.createTopics({
        topics: [{ topic: descriptor.kafkaTopic, numPartitions: 1 }],
        waitForLeaders: true,
      });
      if (!topicCreated) throw new Error('Evaluation sandbox Kafka topic is already in use');
      await this.objects.reserve(descriptor.objectPrefix);
      objectPrefixReserved = true;
    } catch (error) {
      const cleanupErrors = await this.cleanupParts(descriptor, {
        schema: schemaCreated,
        topic: topicCreated,
        objects: objectPrefixReserved,
      });
      throwCombined('Evaluation sandbox resource provisioning failed', error, cleanupErrors);
    }

    let cleanupPromise: Promise<void> | undefined;
    return {
      descriptor,
      cleanup: () => {
        cleanupPromise ??= this.cleanup(descriptor);
        return cleanupPromise;
      },
    };
  }

  public async cleanupAbandoned(descriptor: EvalSandboxDescriptor): Promise<void> {
    assertDescriptor(descriptor);
    const topics = await this.kafka.listTopics();
    const errors = await this.cleanupParts(descriptor, {
      schema: true,
      topic: topics.includes(descriptor.kafkaTopic),
      objects: true,
    });
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Abandoned evaluation sandbox cleanup failed');
    }
  }

  private async cleanup(descriptor: EvalSandboxDescriptor): Promise<void> {
    const errors = await this.cleanupParts(descriptor, {
      schema: true,
      topic: true,
      objects: true,
    });
    if (errors.length > 0) throw new AggregateError(errors, 'Evaluation sandbox cleanup failed');
  }

  private async cleanupParts(
    descriptor: EvalSandboxDescriptor,
    resources: { readonly schema: boolean; readonly topic: boolean; readonly objects: boolean },
  ): Promise<unknown[]> {
    const operations: Promise<unknown>[] = [];
    if (resources.objects) operations.push(this.objects.clear(descriptor.objectPrefix));
    if (resources.topic)
      operations.push(this.kafka.deleteTopics({ topics: [descriptor.kafkaTopic] }));
    if (resources.schema) {
      operations.push(
        this.database.execute(
          sql`drop schema if exists ${sql.identifier(descriptor.databaseSchema)} cascade`,
        ),
      );
    }
    const results = await Promise.allSettled(operations);
    return results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(({ reason }) => reason as unknown);
  }
}

function assertDescriptor(descriptor: EvalSandboxDescriptor): void {
  assertEvalSandboxDescriptor(descriptor, {
    experimentId: descriptor.experimentId,
    armId: descriptor.armId,
    trialId: descriptor.trialId,
    allowedHosts: descriptor.network.allowedHosts,
  });
}

function assertObjectPrefix(prefix: string): void {
  if (!/^eval\/[a-f0-9]{24}\/[a-f0-9]{24}\/[a-f0-9]{24}\/$/u.test(prefix)) {
    throw new Error('Evaluation sandbox object prefix is invalid');
  }
}

function readObjectName(item: unknown): string | undefined {
  if (!item || typeof item !== 'object' || !('name' in item)) return undefined;
  const name = item.name;
  return typeof name === 'string' && name ? name : undefined;
}

function throwCombined(message: string, cause: unknown, cleanupErrors: readonly unknown[]): never {
  if (cleanupErrors.length === 0) throw cause;
  throw new AggregateError([cause, ...cleanupErrors], message);
}

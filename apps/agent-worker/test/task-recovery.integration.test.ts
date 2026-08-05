import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { DirectRunService, type RunEventPublisher } from '@agentpress/agent-application';
import { PiRuntimeAdapter } from '@agentpress/agent-runtime';
import {
  agentRuns,
  agentTasks,
  appUsers,
  connectDatabase,
  conversationBranches,
  conversations,
  inboxMessages,
  outboxMessages,
  requeueExpiredAgentTasks,
  taskResults,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { and, asc, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Kafka, Partitioners, type Consumer, type Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  handleAgentTaskCommand,
  parseAgentTaskCommandPayload,
  type AgentTaskCommandResult,
} from '../src/task-command-handler.js';

const connectionString = process.env.DATABASE_URL;
const brokers = process.env.KAFKA_BROKERS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const describeWithInfrastructure = connectionString && brokers?.length ? describe : describe.skip;

describeWithInfrastructure('Kafka detached Task recovery', () => {
  const connection = connectDatabase(connectionString ?? '');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const topic = `agent.task.integration.${suffix}`;
  const kafka = new Kafka({ brokers: brokers ?? [], clientId: `agent-task-integration-${suffix}` });
  const admin = kafka.admin();
  const producer: Producer = kafka.producer({
    createPartitioner: Partitioners.DefaultPartitioner,
    idempotent: true,
    maxInFlightRequests: 1,
  });
  const consumers: Consumer[] = [];
  const childProcesses = new Set<ReturnType<typeof spawn>>();
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
  };
  const publisher: RunEventPublisher = { publish: () => Promise.resolve() };

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(
        new URL('../../../packages/database/migrations', import.meta.url),
      ),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Kafka recovery integration',
    });
    await connection.db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Kafka recovery integration',
    });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Kafka recovery integration',
    });
    await admin.connect();
    await admin.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: true });
    await producer.connect();
  });

  afterAll(async () => {
    const childExits = [...childProcesses]
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map(async (child) => {
        child.kill('SIGKILL');
        await once(child, 'exit');
      });
    await Promise.allSettled(childExits);
    await Promise.allSettled(consumers.map((consumer) => consumer.disconnect()));
    await producer.disconnect();
    await admin.deleteTopics({ topics: [topic] });
    await admin.disconnect();
    await connection.close();
  });

  it('recovers a disconnected worker once and ignores a duplicate recovery command', async () => {
    const branchId = await createBranch();
    const service = createService([
      toolResponse('plan_submit', {
        goal: 'Recover a detached writer',
        tasks: [{ ...plannedTask('detached-writer'), detached: true }],
      }),
      taskCompleteResponse('Recovered exactly once'),
      runCompleteResponse('Recovered delivery'),
    ]);
    const run = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: 'Recover a detached writer after worker loss',
      idempotencyKey: randomUUID(),
    });
    const execution = service.execute(run.runId);
    const taskId = await waitForTask(run.runId);
    const originalCommand = await waitForTaskCommand(taskId, 'agent.task.commands');
    const lostAt = new Date(Date.now() - 1_000);

    const lostWorker = startLostWorker(lostAt);
    await expect(lostWorker.nextEvent()).resolves.toMatchObject({ event: 'ready' });
    await publish(originalCommand, `${run.runId}:${taskId}`);
    await expect(lostWorker.nextEvent()).resolves.toMatchObject({
      event: 'claimed',
      taskId,
      attempt: 1,
    });
    lostWorker.process.kill('SIGKILL');
    await expect(once(lostWorker.process, 'exit')).resolves.toEqual([null, 'SIGKILL']);

    await expect(
      connection.db.transaction((transaction) =>
        requeueExpiredAgentTasks(transaction, {
          topic,
          createId: randomUUID,
          now: new Date(lostAt.getTime() + 2),
        }),
      ),
    ).resolves.toContainEqual({ taskId, runId: run.runId });
    const recoveryCommand = await waitForTaskCommand(taskId, topic);
    const recoveryMessageId = parseAgentTaskCommandPayload(recoveryCommand)?.messageId;
    expect(recoveryMessageId).toBeDefined();

    const handled: AgentTaskCommandResult[] = [];
    const recovered = deferred<boolean>();
    const recoveryConsumer = await startConsumer(
      `recovery-${suffix}`,
      async (payload, partition, offset) => {
        if (parseAgentTaskCommandPayload(payload)?.messageId !== recoveryMessageId) return;
        handled.push(
          await handleAgentTaskCommand({
            database: connection.db,
            consumerGroup: `recovery-${suffix}`,
            topic,
            partition,
            offset,
            rawPayload: payload,
            executeDetachedTask: (runId, recoveredTaskId, signal) =>
              service.executeDetachedTask(runId, recoveredTaskId, signal),
          }),
        );
        if (handled.length === 2) recovered.resolve(true);
      },
    );
    await producer.send({
      topic,
      messages: [
        { key: `${run.runId}:${taskId}`, value: recoveryCommand },
        { key: `${run.runId}:${taskId}`, value: recoveryCommand },
      ],
    });
    await recovered.promise;
    await recoveryConsumer.stop();
    await expect(execution).resolves.toMatchObject({ status: 'completed' });

    expect(handled).toMatchObject([
      { kind: 'handled', taskId, status: 'succeeded', inbox: 'processed' },
      { kind: 'handled', taskId, status: 'skipped', inbox: 'duplicate' },
    ]);
    await expect(
      connection.db
        .select({ attempt: taskResults.attempt, summary: taskResults.summary })
        .from(taskResults)
        .where(eq(taskResults.taskId, taskId)),
    ).resolves.toEqual([{ attempt: 2, summary: 'Recovered exactly once' }]);
    await expect(
      connection.db
        .select({ status: agentTasks.status, attempt: agentTasks.attempt })
        .from(agentTasks)
        .where(eq(agentTasks.id, taskId)),
    ).resolves.toEqual([{ status: 'succeeded', attempt: 2 }]);
    await expect(
      connection.db
        .select({ messageId: inboxMessages.messageId })
        .from(inboxMessages)
        .where(
          and(
            eq(inboxMessages.consumerGroup, `recovery-${suffix}`),
            eq(inboxMessages.messageId, recoveryMessageId ?? ''),
          ),
        ),
    ).resolves.toHaveLength(1);
  }, 30_000);

  it('does not revive a cancelled Task when its Kafka command arrives late', async () => {
    const branchId = await createBranch();
    const service = createService([
      toolResponse('plan_submit', {
        goal: 'Cancel a detached writer',
        tasks: [{ ...plannedTask('cancelled-writer'), detached: true }],
      }),
      taskCompleteResponse('must not execute'),
    ]);
    const run = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: 'Cancel before the detached command is handled',
      idempotencyKey: randomUUID(),
    });
    const controller = new AbortController();
    const execution = service.execute(run.runId, controller.signal);
    const taskId = await waitForTask(run.runId);
    const command = await waitForTaskCommand(taskId, 'agent.task.commands');
    await expect(service.requestCancellation(run.runId)).resolves.toMatchObject({
      outcome: 'accepted',
    });
    controller.abort();

    const result = deferred<AgentTaskCommandResult>();
    const cancelConsumer = await startConsumer(
      `cancel-${suffix}`,
      async (payload, partition, offset) => {
        if (parseAgentTaskCommandPayload(payload)?.taskId !== taskId) return;
        result.resolve(
          await handleAgentTaskCommand({
            database: connection.db,
            consumerGroup: `cancel-${suffix}`,
            topic,
            partition,
            offset,
            rawPayload: payload,
            executeDetachedTask: (runId, cancelledTaskId, signal) =>
              service.executeDetachedTask(runId, cancelledTaskId, signal),
          }),
        );
      },
    );
    await publish(command, `${run.runId}:${taskId}`);
    await expect(result.promise).resolves.toMatchObject({
      kind: 'handled',
      taskId,
      status: 'skipped',
      inbox: 'processed',
    });
    await cancelConsumer.stop();
    await execution.catch(() => undefined);

    await expect(
      connection.db
        .select({ status: agentTasks.status, attempt: agentTasks.attempt })
        .from(agentTasks)
        .where(eq(agentTasks.id, taskId)),
    ).resolves.toEqual([{ status: 'cancelled', attempt: 0 }]);
    await expect(
      connection.db
        .select({ id: taskResults.id })
        .from(taskResults)
        .where(eq(taskResults.taskId, taskId)),
    ).resolves.toEqual([]);
    await expect(
      connection.db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, run.runId)),
    ).resolves.toEqual([{ status: 'cancelled' }]);
  }, 30_000);

  function createService(responses: Parameters<typeof PiRuntimeAdapter.forTests>[0]['responses']) {
    const runtime = PiRuntimeAdapter.forTests({ responses });
    return new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
  }

  async function createBranch(): Promise<string> {
    const id = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id,
      conversationId: ids.conversation,
    });
    return id;
  }

  async function waitForTask(runId: string): Promise<string> {
    return poll(async () => {
      const rows = await connection.db
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(eq(agentTasks.runId, runId));
      return rows[0]?.id;
    });
  }

  async function waitForTaskCommand(taskId: string, commandTopic: string): Promise<string> {
    return poll(async () => {
      const rows = await connection.db
        .select({ payload: outboxMessages.payload })
        .from(outboxMessages)
        .where(and(eq(outboxMessages.aggregateId, taskId), eq(outboxMessages.topic, commandTopic)))
        .orderBy(asc(outboxMessages.occurredAt));
      return rows[0]?.payload ? JSON.stringify(rows[0].payload) : undefined;
    });
  }

  async function startConsumer(
    groupId: string,
    handler: (payload: string, partition: number, offset: number) => Promise<void>,
  ): Promise<Consumer> {
    const consumer = kafka.consumer({ groupId });
    consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    const joined = deferred<boolean>();
    consumer.on(consumer.events.GROUP_JOIN, () => {
      joined.resolve(true);
    });
    await consumer.run({
      eachMessage: async ({ partition, message }) => {
        await handler(message.value?.toString() ?? '', partition, Number(message.offset));
      },
    });
    await joined.promise;
    return consumer;
  }

  function publish(value: string, key: string): Promise<unknown> {
    return producer.send({ topic, messages: [{ key, value }] });
  }

  function startLostWorker(lostAt: Date) {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('./fixtures/lost-task-worker.ts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          ...process.env,
          DATABASE_URL: connectionString ?? '',
          KAFKA_BROKERS: (brokers ?? []).join(','),
          TEST_AGENT_TASK_TOPIC: topic,
          TEST_AGENT_TASK_GROUP: `lost-process-${suffix}`,
          TEST_AGENT_TASK_LOST_AT: lostAt.toISOString(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    childProcesses.add(child);
    child.once('exit', () => childProcesses.delete(child));
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    return {
      process: child,
      async nextEvent(): Promise<Record<string, unknown>> {
        const line = await lines.next();
        if (line.done) {
          throw new Error(`Lost worker exited before reporting state: ${stderr}`);
        }
        return JSON.parse(line.value) as Record<string, unknown>;
      },
    };
  }
});

function plannedTask(clientKey: string) {
  return {
    clientKey,
    owner: 'writer',
    objective: 'Write a durable result',
    criticality: 'required',
    acceptanceCriteria: ['The result is complete'],
    dependencyKeys: [],
    capabilities: [],
  };
}

function toolResponse(name: string, arguments_: Readonly<Record<string, unknown>>) {
  return fauxAssistantMessage([fauxToolCall(name, arguments_)], { stopReason: 'toolUse' });
}

function taskCompleteResponse(summary: string) {
  return toolResponse('task_complete', {
    status: 'succeeded',
    summary,
    artifacts: [],
    warnings: [],
  });
}

function runCompleteResponse(answer: string) {
  return toolResponse('run_complete', { answer, artifactIds: [], evidenceIds: [] });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function poll<T>(read: () => Promise<T | undefined>, attempts = 200): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for integration state');
}

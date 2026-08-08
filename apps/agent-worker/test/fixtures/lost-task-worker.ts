import { randomUUID } from 'node:crypto';

import { claimAgentTask, connectDatabase } from '@agentpress/database';
import { Kafka, logLevel } from 'kafkajs';

import { parseAgentTaskCommandPayload } from '../../src/task-command-handler.js';

const databaseUrl = requiredEnvironment('DATABASE_URL');
const brokers = requiredEnvironment('KAFKA_BROKERS')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const topic = requiredEnvironment('TEST_AGENT_TASK_TOPIC');
const groupId = requiredEnvironment('TEST_AGENT_TASK_GROUP');
const taskId = requiredEnvironment('TEST_AGENT_TASK_ID');
const lostAt = new Date(requiredEnvironment('TEST_AGENT_TASK_LOST_AT'));
if (Number.isNaN(lostAt.getTime())) throw new Error('TEST_AGENT_TASK_LOST_AT is invalid');

const connection = connectDatabase(databaseUrl);
const kafka = new Kafka({
  brokers,
  clientId: `lost-task-worker-${String(process.pid)}`,
  logLevel: logLevel.NOTHING,
});
const consumer = kafka.consumer({ groupId });
const joined = new Promise<void>((resolve) => {
  consumer.on(consumer.events.GROUP_JOIN, () => {
    resolve();
  });
});

await consumer.connect();
await consumer.subscribe({ topic, fromBeginning: true });
await consumer.run({
  eachMessage: async ({ message }) => {
    const command = parseAgentTaskCommandPayload(message.value?.toString());
    if (!command) throw new Error('Lost worker received an invalid Task command');
    if (command.taskId !== taskId) return;
    const claim = await connection.db.transaction((transaction) =>
      claimAgentTask(transaction, {
        taskId: command.taskId,
        workerId: `lost-process:${String(process.pid)}`,
        leaseId: randomUUID(),
        leaseToken: randomUUID(),
        leaseMs: 1,
        now: lostAt,
      }),
    );
    if (!claim) throw new Error('Lost worker could not claim the Task');
    writeEvent({ event: 'claimed', taskId: command.taskId, attempt: claim.attempt });
    await new Promise<never>(() => undefined);
  },
});
await joined;
writeEvent({ event: 'ready' });

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeEvent(event: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

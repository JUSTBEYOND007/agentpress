import { createHash } from 'node:crypto';

import { parseAgentTaskExecuteCommand } from '@agentpress/agent-application';
import { processInboxMessage, type AgentPressDatabase } from '@agentpress/database';

export type DetachedTaskExecutionStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'not_found';

export type AgentTaskCommandResult =
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'handled';
      readonly runId: string;
      readonly taskId: string;
      readonly status: DetachedTaskExecutionStatus;
      readonly inbox: 'processed' | 'duplicate';
    };

/** Executes one Kafka Task command while retaining PostgreSQL as the idempotency fact source. */
export async function handleAgentTaskCommand(input: {
  readonly database: AgentPressDatabase;
  readonly consumerGroup: string;
  readonly topic: string;
  readonly partition: number;
  readonly offset: number;
  readonly rawPayload: string | undefined;
  readonly signal?: AbortSignal;
  readonly executeDetachedTask: (
    runId: string,
    taskId: string,
    signal?: AbortSignal,
  ) => Promise<DetachedTaskExecutionStatus>;
}): Promise<AgentTaskCommandResult> {
  const command = parseAgentTaskCommandPayload(input.rawPayload);
  if (!command) return { kind: 'invalid' };

  const status = await input.executeDetachedTask(command.runId, command.taskId, input.signal);
  const inbox = await processInboxMessage(
    input.database,
    {
      consumerGroup: input.consumerGroup,
      messageId: command.messageId,
      topic: input.topic,
      partition: input.partition,
      offset: input.offset,
      payloadHash: createHash('sha256')
        .update(input.rawPayload ?? '')
        .digest('hex'),
    },
    () => Promise.resolve(),
  );
  return {
    kind: 'handled',
    runId: command.runId,
    taskId: command.taskId,
    status,
    inbox,
  };
}

export function parseAgentTaskCommandPayload(payload: string | undefined) {
  if (!payload) return undefined;
  try {
    return parseAgentTaskExecuteCommand(JSON.parse(payload) as unknown);
  } catch {
    return undefined;
  }
}

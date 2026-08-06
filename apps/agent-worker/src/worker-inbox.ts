import { createHash } from 'node:crypto';

import { processInboxMessage, type DatabaseConnection } from '@agentpress/database';

export async function acknowledgeWorkerCommand(
  database: DatabaseConnection['db'],
  consumerGroup: string,
  messageId: string,
  topic: string,
  partition: number,
  offset: number,
  rawPayload: string | undefined,
): Promise<'processed' | 'duplicate'> {
  return processInboxMessage(
    database,
    {
      consumerGroup,
      messageId,
      topic,
      partition,
      offset,
      payloadHash: createHash('sha256')
        .update(rawPayload ?? '')
        .digest('hex'),
    },
    () => Promise.resolve(),
  );
}

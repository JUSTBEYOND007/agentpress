import { eq, and } from 'drizzle-orm';

import type { AgentPressDatabase, DatabaseTransaction } from './postgres.js';
import { inboxMessages } from './schema.js';

export type InboxEnvelope = {
  readonly consumerGroup: string;
  readonly messageId: string;
  readonly topic: string;
  readonly partition: number;
  readonly offset: number;
  readonly payloadHash: string;
};

export async function processInboxMessage(
  db: AgentPressDatabase,
  envelope: InboxEnvelope,
  handler: (transaction: DatabaseTransaction) => Promise<void>,
): Promise<'processed' | 'duplicate'> {
  return db.transaction(async (transaction) => {
    const claimed = await transaction
      .insert(inboxMessages)
      .values(envelope)
      .onConflictDoNothing()
      .returning({ messageId: inboxMessages.messageId });

    if (claimed.length === 0) {
      return 'duplicate';
    }

    await handler(transaction);
    await transaction
      .update(inboxMessages)
      .set({ processedAt: new Date() })
      .where(
        and(
          eq(inboxMessages.consumerGroup, envelope.consumerGroup),
          eq(inboxMessages.messageId, envelope.messageId),
        ),
      );

    return 'processed';
  });
}

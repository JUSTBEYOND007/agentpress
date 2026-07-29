import { sql } from 'drizzle-orm';

import type { AgentPressDatabase, DatabaseTransaction } from './postgres.js';
import { outboxMessages } from './schema.js';

export type OutboxEnvelope = {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly topic: string;
  readonly messageKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly occurredAt: Date;
};

export async function enqueueOutboxMessage(
  transaction: DatabaseTransaction,
  envelope: OutboxEnvelope,
): Promise<void> {
  await transaction.insert(outboxMessages).values({
    ...envelope,
    headers: envelope.headers ?? {},
  });
}

export type ClaimedOutboxMessage = typeof outboxMessages.$inferSelect;

export async function claimOutboxMessages(
  db: AgentPressDatabase,
  workerId: string,
  limit: number,
  lockTimeoutSeconds = 60,
): Promise<readonly ClaimedOutboxMessage[]> {
  const result = await db.execute<ClaimedOutboxMessage>(sql`
    with candidates as (
      select id
      from ${outboxMessages}
      where published_at is null
        and available_at <= now()
        and (locked_at is null or locked_at < now() - (${lockTimeoutSeconds} * interval '1 second'))
      order by occurred_at, id
      for update skip locked
      limit ${limit}
    )
    update ${outboxMessages}
    set locked_at = now(),
        locked_by = ${workerId},
        attempts = attempts + 1
    from candidates
    where ${outboxMessages.id} = candidates.id
    returning *
  `);

  return result.rows;
}

export async function markOutboxMessagePublished(
  db: AgentPressDatabase,
  messageId: string,
  workerId: string,
  publishedAt: Date,
): Promise<boolean> {
  const result = await db.execute(sql`
    update ${outboxMessages}
    set published_at = ${publishedAt},
        locked_at = null,
        locked_by = null,
        last_error = null
    where id = ${messageId}
      and locked_by = ${workerId}
      and published_at is null
  `);

  return (result.rowCount ?? 0) === 1;
}

export async function releaseOutboxMessage(
  db: AgentPressDatabase,
  messageId: string,
  workerId: string,
  availableAt: Date,
  error: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    update ${outboxMessages}
    set available_at = ${availableAt},
        locked_at = null,
        locked_by = null,
        last_error = ${error}
    where id = ${messageId}
      and locked_by = ${workerId}
      and published_at is null
  `);

  return (result.rowCount ?? 0) === 1;
}

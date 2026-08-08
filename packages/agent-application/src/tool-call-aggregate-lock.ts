import { agentRuns, type DatabaseTransaction, toolCalls } from '@agentpress/database';
import { eq, sql } from 'drizzle-orm';

export async function lockToolCallAggregate(
  transaction: DatabaseTransaction,
  toolCallId: string,
): Promise<string | undefined> {
  const ownership = await transaction
    .select({ runId: toolCalls.runId })
    .from(toolCalls)
    .where(eq(toolCalls.id, toolCallId))
    .limit(1);
  const runId = ownership[0]?.runId;
  if (!runId) return undefined;

  await transaction.execute(sql`select id from ${agentRuns} where id = ${runId} for update`);
  await transaction.execute(sql`select id from ${toolCalls} where id = ${toolCallId} for update`);
  return runId;
}

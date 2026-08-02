import type { AgentRun } from '@agentpress/domain';
import { and, eq } from 'drizzle-orm';

import type { DatabaseTransaction } from './postgres.js';
import { agentRuns } from './schema.js';

export async function insertAgentRun(
  transaction: DatabaseTransaction,
  run: AgentRun,
): Promise<void> {
  await transaction.insert(agentRuns).values({
    id: run.id,
    workspaceId: run.workspaceId,
    branchId: run.conversationBranchId,
    rootRequestId: run.rootRequestId,
    mode: run.mode,
    status: run.status,
    version: run.version,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.activePlanRevisionId ? { activePlanRevisionId: run.activePlanRevisionId } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
  });
}

export async function updateAgentRun(
  transaction: DatabaseTransaction,
  run: AgentRun,
  expectedVersion: number,
): Promise<boolean> {
  const updated = await transaction
    .update(agentRuns)
    .set({
      mode: run.mode,
      status: run.status,
      version: run.version,
      updatedAt: run.updatedAt,
      activePlanRevisionId: run.activePlanRevisionId ?? null,
      completedAt: run.completedAt ?? null,
    })
    .where(and(eq(agentRuns.id, run.id), eq(agentRuns.version, expectedVersion)))
    .returning({ id: agentRuns.id });

  return updated.length === 1;
}

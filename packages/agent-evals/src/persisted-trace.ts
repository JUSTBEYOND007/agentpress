import {
  actionProposals,
  agentTasks,
  approvals,
  editProposalBatches,
  editProposalDecisions,
  editProposals,
  evidenceRecords,
  runEvents,
  taskResults,
  toolCalls,
  type AgentPressDatabase,
} from '@agentpress/database';
import { asc, eq } from 'drizzle-orm';

import type { EvalTraceEvent } from './trace-metrics.js';

type TimedTraceEvent = {
  readonly at: Date;
  readonly order: string;
  readonly event: EvalTraceEvent;
};

export async function loadPersistedRunTrace(
  database: AgentPressDatabase,
  runId: string,
): Promise<readonly EvalTraceEvent[]> {
  const [
    events,
    tasks,
    results,
    calls,
    approvalRows,
    evidence,
    actions,
    proposals,
    batches,
    decisions,
  ] = await Promise.all([
    database
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.sequence)),
    database
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.runId, runId))
      .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id)),
    database
      .select({ result: taskResults, taskId: agentTasks.id })
      .from(taskResults)
      .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
      .where(eq(agentTasks.runId, runId))
      .orderBy(asc(taskResults.createdAt), asc(taskResults.id)),
    database
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, runId))
      .orderBy(asc(toolCalls.createdAt), asc(toolCalls.id)),
    database
      .select({ approval: approvals })
      .from(approvals)
      .innerJoin(toolCalls, eq(toolCalls.id, approvals.toolCallId))
      .where(eq(toolCalls.runId, runId))
      .orderBy(asc(approvals.createdAt), asc(approvals.id)),
    database
      .select()
      .from(evidenceRecords)
      .where(eq(evidenceRecords.runId, runId))
      .orderBy(asc(evidenceRecords.createdAt), asc(evidenceRecords.id)),
    database
      .select()
      .from(actionProposals)
      .where(eq(actionProposals.sourceRunId, runId))
      .orderBy(asc(actionProposals.createdAt), asc(actionProposals.id)),
    database
      .select()
      .from(editProposals)
      .where(eq(editProposals.runId, runId))
      .orderBy(asc(editProposals.createdAt), asc(editProposals.id)),
    database
      .select({ batch: editProposalBatches })
      .from(editProposalBatches)
      .innerJoin(editProposals, eq(editProposals.id, editProposalBatches.proposalId))
      .where(eq(editProposals.runId, runId))
      .orderBy(asc(editProposalBatches.createdAt), asc(editProposalBatches.id)),
    database
      .select({ decision: editProposalDecisions })
      .from(editProposalDecisions)
      .innerJoin(editProposals, eq(editProposals.id, editProposalDecisions.proposalId))
      .where(eq(editProposals.runId, runId))
      .orderBy(asc(editProposalDecisions.decidedAt), asc(editProposalDecisions.operationId)),
  ]);

  const trace: TimedTraceEvent[] = [];
  for (const row of events) {
    trace.push(
      timed(row.createdAt, `00:${String(row.sequence).padStart(12, '0')}`, row.eventType, {
        ...row.payload,
        source: 'run_event',
        eventId: row.id,
        sequence: row.sequence,
        eventVersion: row.eventVersion,
        timestamp: row.createdAt.getTime(),
      }),
    );
  }
  for (const row of tasks) {
    trace.push(
      timed(row.createdAt, `10:${row.id}`, 'task.fact', {
        source: 'agent_task',
        taskId: row.id,
        planRevisionId: row.planRevisionId,
        owner: row.owner,
        criticality: row.criticality,
        status: row.status,
        attempt: row.attempt,
        maxAttempts: row.maxAttempts,
        version: row.version,
        acceptanceCriteriaCount: row.acceptanceCriteria.length,
        outputSchemaHash: stableHash(row.outputSchema),
      }),
    );
  }
  for (const { result, taskId } of results) {
    trace.push(
      timed(result.createdAt, `20:${result.id}`, 'task.settlement', {
        source: 'task_result',
        resultId: result.id,
        taskId,
        attempt: result.attempt,
        status: result.status,
        artifactCount: result.artifacts.length,
        evidenceCount: result.evidence.length,
        warningCount: result.warnings.length,
        usage: result.usage,
        failure: result.failure,
      }),
    );
  }
  for (const row of calls) {
    trace.push(
      timed(row.settledAt ?? row.updatedAt, `30:${row.id}`, 'tool.settlement', {
        source: 'tool_call',
        toolCallId: row.id,
        taskId: row.taskId,
        providerToolCallId: row.providerToolCallId,
        toolId: row.toolId,
        toolVersion: row.toolVersion,
        argumentsHash: row.argumentsHash,
        risk: row.risk,
        status: row.status,
        idempotencyKeyHash: row.idempotencyKey ? stableHash(row.idempotencyKey) : null,
        outputHash: row.output == null ? null : stableHash(row.output),
        failure: row.failure,
        version: row.version,
      }),
    );
  }
  for (const { approval } of approvalRows) {
    trace.push(
      timed(approval.decidedAt ?? approval.createdAt, `40:${approval.id}`, 'approval.settlement', {
        source: 'approval',
        approvalId: approval.id,
        toolCallId: approval.toolCallId,
        decision: approval.decision,
        toolVersion: approval.toolVersion,
        argumentsHash: approval.argumentsHash,
        estimatedCost: approval.estimatedCost,
        expiresAt: approval.expiresAt.toISOString(),
        decidedAt: approval.decidedAt?.toISOString() ?? null,
      }),
    );
  }
  for (const row of evidence) {
    trace.push(
      timed(row.createdAt, `50:${row.id}`, 'evidence.persisted', {
        source: 'evidence_record',
        evidenceId: row.id,
        taskId: row.taskId,
        sourceType: row.sourceType,
        sourceRevision: row.sourceRevision,
        contentHash: row.contentHash,
        metadataHash: stableHash(row.metadata),
      }),
    );
  }
  for (const row of actions) {
    trace.push(
      timed(row.updatedAt, `60:${row.id}`, 'action_proposal.settlement', {
        source: 'action_proposal',
        proposalId: row.id,
        articleId: row.articleId,
        baseRevisionId: row.baseRevisionId,
        status: row.status,
        selectedBlockCount: row.selectedBlocks.length,
        grantedCapabilities: row.grantedCapabilities,
        confirmedRunId: row.confirmedRunId,
        confirmedAt: row.confirmedAt?.toISOString() ?? null,
      }),
    );
  }
  for (const row of proposals) {
    trace.push(
      timed(row.updatedAt, `70:${row.id}`, 'edit_proposal.settlement', {
        source: 'edit_proposal',
        proposalId: row.id,
        articleId: row.articleId,
        baseRevisionId: row.baseRevisionId,
        sourceToolCallId: row.sourceToolCallId,
        reviewMode: row.reviewMode,
        status: row.status,
        operationCount: row.operations.length,
        diffCount: row.diffs.length,
      }),
    );
  }
  for (const { batch } of batches) {
    trace.push(
      timed(batch.updatedAt, `80:${batch.id}`, 'proposal_batch.settlement', {
        source: 'edit_proposal_batch',
        batchId: batch.id,
        proposalId: batch.proposalId,
        sourceToolCallId: batch.sourceToolCallId,
        batchNumber: batch.batchNumber,
        status: batch.status,
        operationCount: batch.operations.length,
        diffCount: batch.diffs.length,
        beforeHash: batch.beforeHash,
        afterHash: batch.afterHash,
      }),
    );
  }
  for (const { decision } of decisions) {
    trace.push(
      timed(
        decision.decidedAt,
        `90:${decision.proposalId}:${decision.operationId}`,
        'proposal_operation.settlement',
        {
          source: 'edit_proposal_decision',
          proposalId: decision.proposalId,
          operationId: decision.operationId,
          decision: decision.decision,
        },
      ),
    );
  }
  return trace
    .sort(
      (left, right) =>
        left.at.getTime() - right.at.getTime() || left.order.localeCompare(right.order),
    )
    .map(({ event }) => event);
}

function timed(
  at: Date,
  order: string,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): TimedTraceEvent {
  return { at, order, event: { type, payload: { ...payload, persistedAt: at.toISOString() } } };
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, objectKeySorter)).digest('hex');
}

function objectKeySorter(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
  );
}
import { createHash } from 'node:crypto';

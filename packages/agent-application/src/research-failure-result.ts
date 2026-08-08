import { evidenceRecords, toolCalls, type AgentPressDatabase } from '@agentpress/database';
import { buildDegradedResearchBrief, type ResearchFailure } from '@agentpress/web-research';
import { and, eq, isNotNull } from 'drizzle-orm';

import type { PlannedTaskSpec, SettledTask } from './planned-run-protocol.js';

const HOST_FAILURE_REVISION = 'agentpress-research-failure-v1';

export class ResearchFailureResultFactory {
  public constructor(private readonly database: AgentPressDatabase) {}

  public async create(
    runId: string,
    task: PlannedTaskSpec,
    failureCode: string,
  ): Promise<SettledTask> {
    if (task.owner !== 'researcher') {
      throw new TypeError('Research failure artifacts require a researcher Task');
    }
    const rows = await this.database
      .select({
        evidenceId: evidenceRecords.id,
        title: evidenceRecords.title,
        sourceUri: evidenceRecords.sourceUri,
        providerRevision: toolCalls.evidenceProviderRevision,
      })
      .from(evidenceRecords)
      .innerJoin(toolCalls, eq(toolCalls.id, evidenceRecords.sourceToolCallId))
      .where(
        and(
          eq(evidenceRecords.runId, runId),
          eq(evidenceRecords.taskId, task.id),
          eq(toolCalls.runId, runId),
          eq(toolCalls.taskId, task.id),
          eq(toolCalls.status, 'succeeded'),
          isNotNull(toolCalls.evidenceProviderRevision),
        ),
      )
      .orderBy(evidenceRecords.createdAt, evidenceRecords.id);
    const revisions = new Set(
      rows.flatMap(({ providerRevision }) => (providerRevision ? [providerRevision] : [])),
    );
    const sameRevision = revisions.size === 1;
    const retained = sameRevision ? rows.slice(0, 24) : [];
    const failures: ResearchFailure[] = [researchFailure(failureCode)];
    if (rows.length > 0 && !sameRevision) {
      failures.push({
        kind: 'provider_schema_invalid',
        detail: 'Retained Evidence does not share one provider revision',
      });
    }
    const content = buildDegradedResearchBrief({
      purpose: 'general',
      depth: 'deep',
      summary: 'Research evidence was retained, but synthesis did not produce a verified result.',
      sources: retained.map(({ evidenceId, title, sourceUri }) => ({
        evidenceId,
        title,
        ...(sourceUri ? { sourceUri } : {}),
      })),
      failures,
      providerRevision: sameRevision
        ? ([...revisions][0] ?? HOST_FAILURE_REVISION)
        : HOST_FAILURE_REVISION,
    });
    return {
      ...task,
      status: 'failed',
      summary: content.summary,
      artifacts: [
        {
          type: 'ResearchBrief',
          title: 'Incomplete research',
          summary: content.summary,
          content,
          evidenceIds: content.sources.map(({ evidenceId }) => evidenceId),
        },
      ],
      warnings: content.partialFailures,
      failure: failureCode,
    };
  }
}

function researchFailure(code: string): ResearchFailure {
  if (code === 'task_timeout' || code === 'detached_task_timeout') {
    return { kind: 'synthesis_timeout', detail: 'Research synthesis timed out' };
  }
  if (code === 'attempt_budget_exhausted') {
    return { kind: 'budget_exhausted', detail: 'Research execution budget was exhausted' };
  }
  if (
    code === 'task_result_schema_invalid' ||
    code === 'task_artifact_invalid' ||
    code === 'task_evidence_invalid' ||
    code === 'task_evidence_provenance_invalid' ||
    code === 'protocol_error'
  ) {
    return { kind: 'synthesis_schema_invalid', detail: 'Research synthesis failed validation' };
  }
  return { kind: 'synthesis_failed', detail: 'Research synthesis did not complete' };
}

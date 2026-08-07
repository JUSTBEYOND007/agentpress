import { createHash } from 'node:crypto';

import {
  agentTasks,
  appendCheckpoint,
  appendRunEvent,
  artifactEvidence,
  artifacts,
  artifactVersions,
  enqueueOutboxMessage,
  evidenceRecords,
  settleAgentTaskAttempt,
  taskResults,
  toolCalls,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { AGENT_RUN_COMMAND_TOPIC, type RunEventPublisher } from './contracts.js';
import type { PlannedTaskSpec, SettledTask } from './planned-run-protocol.js';
import { toDurableEvent } from './run-projection-service.js';

type SpecialistResultStoreOptions = {
  readonly database: AgentPressDatabase;
  readonly publisher: RunEventPublisher;
  readonly createId: () => string;
  readonly now: () => Date;
};

export class SpecialistResultStore {
  public constructor(private readonly options: SpecialistResultStoreOptions) {}

  public async persistTaskResult(
    runId: string,
    result: SettledTask,
    expectedAttempt: number,
  ): Promise<boolean> {
    const event = await this.options.database.transaction(async (transaction) => {
      const now = this.options.now();
      if (
        !(await settleAgentTaskAttempt(transaction, {
          taskId: result.id,
          attempt: expectedAttempt,
          status: result.status,
          now,
        }))
      ) {
        return undefined;
      }
      const persistedArtifacts = [];
      for (const artifact of result.artifacts) {
        const artifactId = this.options.createId();
        const versionId = this.options.createId();
        const contentHash = createHash('sha256')
          .update(JSON.stringify(artifact.content))
          .digest('hex');
        await transaction.insert(artifacts).values({
          id: artifactId,
          runId,
          taskId: result.id,
          type: artifact.type,
          title: artifact.title,
        });
        await transaction.insert(artifactVersions).values({
          id: versionId,
          artifactId,
          version: 1,
          summary: artifact.summary,
          content: artifact.content,
          contentHash,
        });
        if (artifact.evidenceIds.length > 0) {
          await transaction.insert(artifactEvidence).values(
            artifact.evidenceIds.map((evidenceId, ordinal) => ({
              artifactVersionId: versionId,
              evidenceId,
              claim: artifact.summary,
              ordinal: ordinal + 1,
            })),
          );
        }
        persistedArtifacts.push({ artifactId, versionId, ...artifact });
      }
      if (result.status !== 'cancelled' && result.status !== 'skipped') {
        await transaction.insert(taskResults).values({
          id: this.options.createId(),
          taskId: result.id,
          attempt: expectedAttempt,
          status: result.status,
          summary: result.summary ?? result.failure ?? `${result.owner} task ${result.status}`,
          artifacts: persistedArtifacts,
          evidence: [...new Set(result.artifacts.flatMap(({ evidenceIds }) => evidenceIds))],
          usage: result.usage ?? {},
          warnings: result.warnings,
          ...(result.failure ? { failure: { code: result.failure, message: result.failure } } : {}),
        });
      }
      await appendCheckpoint(transaction, {
        id: this.options.createId(),
        runId,
        reason: 'task_settled',
        state: { taskId: result.id, status: result.status },
      });
      const event = await appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: `task.${result.status}`,
        payload: {
          taskId: result.id,
          owner: result.owner,
          criticality: result.criticality,
          summary: result.summary,
          artifacts: persistedArtifacts.map(({ artifactId, type, title, summary }) => ({
            artifactId,
            type,
            title,
            summary,
          })),
          ...(result.failure ? { failure: result.failure } : {}),
        },
      });
      await enqueueOutboxMessage(transaction, {
        id: this.options.createId(),
        aggregateType: 'AgentRun',
        aggregateId: runId,
        topic: AGENT_RUN_COMMAND_TOPIC,
        messageKey: runId,
        payload: { command: 'run.execute', messageId: this.options.createId(), runId },
        occurredAt: this.options.now(),
      });
      return event;
    });
    if (!event) return false;
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
    return true;
  }

  public async updateTaskStatus(
    runId: string,
    task: PlannedTaskSpec,
    status: 'skipped',
    failure?: string,
  ): Promise<number | undefined> {
    const event = await this.options.database.transaction(async (transaction) => {
      const now = this.options.now();
      const updated = await transaction
        .update(agentTasks)
        .set({
          status,
          completedAt: now,
          updatedAt: now,
          version: sql`${agentTasks.version} + 1`,
        })
        .where(eq(agentTasks.id, task.id))
        .returning({ attempt: agentTasks.attempt });
      if (updated.length === 0) return undefined;
      const event = await appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: 'task.skipped',
        payload: { taskId: task.id, owner: task.owner, ...(failure ? { failure } : {}) },
      });
      return { attempt: updated[0]?.attempt, event };
    });
    if (event?.attempt === undefined) return undefined;
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event.event) });
    return event.attempt;
  }

  public async assertRunReferences(
    runId: string,
    artifactIds: readonly string[],
    evidenceIds: readonly string[],
  ): Promise<void> {
    const [artifactRows, evidenceRows] = await Promise.all([
      artifactIds.length === 0
        ? Promise.resolve([])
        : this.options.database
            .select({ id: artifacts.id })
            .from(artifacts)
            .where(and(eq(artifacts.runId, runId), inArray(artifacts.id, artifactIds))),
      evidenceIds.length === 0
        ? Promise.resolve([])
        : this.options.database
            .select({ id: evidenceRecords.id })
            .from(evidenceRecords)
            .where(and(eq(evidenceRecords.runId, runId), inArray(evidenceRecords.id, evidenceIds))),
    ]);
    if (new Set(artifactRows.map(({ id }) => id)).size !== new Set(artifactIds).size) {
      throw new Error('run_complete references an artifact outside the current Run');
    }
    if (new Set(evidenceRows.map(({ id }) => id)).size !== new Set(evidenceIds).size) {
      throw new Error('run_complete references Evidence outside the current Run');
    }
  }

  public async assertTaskEvidence(
    runId: string,
    taskId: string,
    evidenceIds: readonly string[],
  ): Promise<void> {
    if (evidenceIds.length === 0) return;
    const rows = await this.options.database
      .select({ id: evidenceRecords.id })
      .from(evidenceRecords)
      .where(
        and(
          eq(evidenceRecords.runId, runId),
          eq(evidenceRecords.taskId, taskId),
          inArray(evidenceRecords.id, evidenceIds),
        ),
      );
    if (new Set(rows.map(({ id }) => id)).size !== new Set(evidenceIds).size) {
      throw new Error('task_complete references Evidence not produced for this task');
    }
  }

  public async resolveTaskEvidenceProviderRevision(
    runId: string,
    taskId: string,
    evidenceIds: readonly string[],
  ): Promise<string> {
    const requestedIds = [...new Set(evidenceIds)];
    const rows =
      requestedIds.length > 0
        ? await this.options.database
            .select({
              evidenceId: evidenceRecords.id,
              providerRevision: toolCalls.evidenceProviderRevision,
            })
            .from(evidenceRecords)
            .innerJoin(toolCalls, eq(toolCalls.id, evidenceRecords.sourceToolCallId))
            .where(
              and(
                eq(evidenceRecords.runId, runId),
                eq(evidenceRecords.taskId, taskId),
                inArray(evidenceRecords.id, requestedIds),
                eq(toolCalls.runId, runId),
                eq(toolCalls.taskId, taskId),
                eq(toolCalls.status, 'succeeded'),
                isNotNull(toolCalls.evidenceProviderRevision),
              ),
            )
        : await this.options.database
            .select({
              evidenceId: toolCalls.id,
              providerRevision: toolCalls.evidenceProviderRevision,
            })
            .from(toolCalls)
            .where(
              and(
                eq(toolCalls.runId, runId),
                eq(toolCalls.taskId, taskId),
                isNotNull(toolCalls.evidenceProviderRevision),
              ),
            );
    if (
      requestedIds.length > 0 &&
      new Set(rows.map(({ evidenceId }) => evidenceId)).size !== requestedIds.length
    ) {
      throw new Error('ResearchBrief sources lack Tool Call provider provenance');
    }
    const revisions = new Set(
      rows.flatMap(({ providerRevision }) => (providerRevision ? [providerRevision] : [])),
    );
    if (revisions.size !== 1) {
      throw new Error('ResearchBrief sources must share one Tool Call provider revision');
    }
    const revision = revisions.values().next().value;
    if (!revision) throw new Error('ResearchBrief provider revision is unavailable');
    return revision;
  }
}

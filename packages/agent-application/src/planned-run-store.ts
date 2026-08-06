import { createHash } from 'node:crypto';

import type { RuntimeCurrentTurn, RuntimeUsage } from '@agentpress/agent-runtime';
import {
  agentRuns,
  agentTaskDependencies,
  agentTasks,
  appendCheckpoint,
  appendRunEvent,
  contextPacks,
  type DatabaseTransaction,
  enqueueOutboxMessage,
  planRevisionTasks,
  runQuestions,
  taskBriefs,
  taskResults,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { AGENT_TASK_COMMAND_TOPIC, type RunEventPublisher } from './contracts.js';
import {
  artifactTypes,
  specialistApplicationTurn,
  taskCompleteSchema,
  type ArtifactType,
  type PlannedTaskSpec,
  type SettledTask,
  type StructuredArtifact,
} from './planned-run-protocol.js';
import {
  assertSpecialistOutputSchema,
  createSpecialistTaskRequest,
  parseSpecialistTaskRequest,
  resolveSpecialistOutputSchema,
  type SpecialistRole,
} from './specialist-task-contract.js';
import { toDurableEvent } from './run-projection-service.js';

type PlannedRunStoreOptions = {
  readonly database: AgentPressDatabase;
  readonly publisher: RunEventPublisher;
  readonly createId: () => string;
  readonly now: () => Date;
};

export class PlannedRunStore {
  public constructor(private readonly options: PlannedRunStoreOptions) {}

  public async claimPlanning(runId: string, from: 'queued' | 'recovering'): Promise<boolean> {
    const persisted = await this.options.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(agentRuns)
        .set({
          status: 'planning',
          updatedAt: this.options.now(),
          version: sql`${agentRuns.version} + 1`,
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, from)))
        .returning({ id: agentRuns.id });
      if (rows.length === 0) return undefined;
      return appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: 'run.planning',
        payload: { recovered: from === 'recovering' },
      });
    });
    if (!persisted) return false;
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(persisted) });
    return true;
  }

  public async enterRunning(runId: string, mode: 'direct' | 'planned'): Promise<void> {
    const event = await this.options.database.transaction(async (transaction) => {
      await transaction
        .update(agentRuns)
        .set({
          status: 'running',
          updatedAt: this.options.now(),
          version: sql`${agentRuns.version} + 1`,
        })
        .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ['planning', 'recovering'])));
      return appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: 'run.started',
        payload: { mode },
      });
    });
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
  }

  public async persistQuestion(
    runId: string,
    question: string,
    options: readonly string[],
  ): Promise<void> {
    const event = await this.options.database.transaction(async (transaction) => {
      const questionId = this.options.createId();
      await transaction
        .insert(runQuestions)
        .values({ id: questionId, runId, prompt: question, options });
      await transaction
        .update(agentRuns)
        .set({
          status: 'waiting_for_user',
          updatedAt: this.options.now(),
          version: sql`${agentRuns.version} + 1`,
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'planning')));
      await appendCheckpoint(transaction, {
        id: this.options.createId(),
        runId,
        reason: 'waiting_for_user',
        state: { questionId },
      });
      return appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: 'user.input_requested',
        payload: { questionId, question, options },
      });
    });
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
  }

  public async persistRevisionTasks(
    transaction: DatabaseTransaction,
    runId: string,
    revisionId: string,
    tasks: readonly PlannedTaskSpec[],
    prompt: RuntimeCurrentTurn,
    positionOffset = 0,
  ): Promise<void> {
    const requests = tasks.map((task) => {
      const contextPackId = this.options.createId();
      const schema = resolveSpecialistOutputSchema({
        callerOutputSchema: taskCompleteSchema,
        schemaMode: 'strict',
      });
      assertSpecialistOutputSchema(schema);
      return {
        task,
        schema,
        request: createSpecialistTaskRequest({
          taskId: task.id,
          runId,
          depth: 0,
          owner: task.owner,
          objective: task.objective,
          contextPackId,
          capabilities: task.capabilities,
          outputSchema: schema.schema,
          timeoutMs: 120_000,
          maxAttempts: 3,
          detached: task.detached,
        }),
      };
    });
    await transaction.insert(agentTasks).values(
      requests.map(({ task, request, schema }) => ({
        id: request.taskId,
        runId,
        planRevisionId: revisionId,
        objective: task.objective,
        criticality: task.criticality,
        owner: task.owner,
        acceptanceCriteria: task.acceptanceCriteria,
        outputSchema: request.outputSchema,
        toolPolicy: {
          capabilities: task.capabilities,
          request,
          outputSchemaSource: schema.source,
          outputSchemaMode: schema.mode,
        },
        budget: {
          maxAttempts: request.maxAttempts,
          protocolRepairTurns: 2,
          timeoutMs: request.timeoutMs,
        },
        status: 'pending' as const,
        maxAttempts: request.maxAttempts,
      })),
    );
    await transaction.insert(planRevisionTasks).values(
      tasks.map((task, position) => ({
        planRevisionId: revisionId,
        taskId: task.id,
        position: position + positionOffset,
      })),
    );
    const dependencies = tasks.flatMap((task) =>
      task.dependencyIds.map((dependencyTaskId) => ({ taskId: task.id, dependencyTaskId })),
    );
    if (dependencies.length > 0) {
      await transaction.insert(agentTaskDependencies).values(dependencies);
    }
    for (const { task, request } of requests) {
      const content = JSON.stringify({
        rootRequest: specialistApplicationTurn(prompt, ''),
        task,
        specialistTaskRequest: request,
      });
      const contentHash = createHash('sha256').update(content).digest('hex');
      await transaction.insert(taskBriefs).values({
        id: this.options.createId(),
        taskId: task.id,
        objective: task.objective,
        constraints: ['Use only the immutable Context Pack', 'Return no hidden chain of thought'],
        expectedOutput: taskCompleteSchema,
        contentHash,
      });
      await transaction.insert(contextPacks).values({
        id: request.contextPackId ?? this.options.createId(),
        taskId: task.id,
        manifest: {
          runId,
          revisionId,
          taskId: task.id,
          parentTaskId: request.parentTaskId ?? null,
          depth: request.depth,
          detached: request.detached,
          capabilities: task.capabilities,
        },
        content,
        format: 'json',
        schemaVersion: 1,
        contentHash,
        tokenCount: Math.ceil(content.length / 3),
      });
      if (request.detached) {
        await enqueueOutboxMessage(transaction, {
          id: this.options.createId(),
          aggregateType: 'AgentTask',
          aggregateId: request.taskId,
          topic: AGENT_TASK_COMMAND_TOPIC,
          messageKey: `${runId}:${request.taskId}`,
          payload: {
            command: 'task.execute',
            messageId: this.options.createId(),
            runId,
            taskId: request.taskId,
          },
          occurredAt: this.options.now(),
        });
      }
    }
  }

  public async loadPlanTasks(
    runId: string,
    revisionId: string,
  ): Promise<readonly PlannedTaskSpec[]> {
    const rows = await this.options.database
      .select({
        id: agentTasks.id,
        owner: agentTasks.owner,
        objective: agentTasks.objective,
        criticality: agentTasks.criticality,
        acceptanceCriteria: agentTasks.acceptanceCriteria,
        toolPolicy: agentTasks.toolPolicy,
      })
      .from(agentTasks)
      .where(and(eq(agentTasks.runId, runId), eq(agentTasks.planRevisionId, revisionId)));
    const dependencies = await this.options.database
      .select()
      .from(agentTaskDependencies)
      .innerJoin(agentTasks, eq(agentTasks.id, agentTaskDependencies.taskId))
      .where(eq(agentTasks.planRevisionId, revisionId));
    return rows.map((row) => {
      const request = parseSpecialistTaskRequest(row.toolPolicy.request);
      if (request && (request.taskId !== row.id || request.runId !== runId)) {
        throw new Error(`Persisted Specialist Task ${row.id} has an identity mismatch`);
      }
      const capabilities =
        request?.capabilities ??
        (Array.isArray(row.toolPolicy.capabilities)
          ? row.toolPolicy.capabilities.filter(
              (value): value is string => typeof value === 'string',
            )
          : []);
      return {
        id: row.id,
        clientKey: row.id,
        owner: row.owner as SpecialistRole,
        objective: row.objective,
        criticality: row.criticality,
        acceptanceCriteria: row.acceptanceCriteria,
        dependencyIds: dependencies
          .filter(({ agent_task_dependencies: dependency }) => dependency.taskId === row.id)
          .map(({ agent_task_dependencies: dependency }) => dependency.dependencyTaskId),
        capabilities,
        detached: request?.detached ?? false,
      };
    });
  }

  public async loadPersistedTaskResults(
    tasks: readonly PlannedTaskSpec[],
  ): Promise<ReadonlyMap<string, SettledTask>> {
    if (tasks.length === 0) return new Map();
    const rows = await this.options.database
      .select({
        taskId: taskResults.taskId,
        status: taskResults.status,
        summary: taskResults.summary,
        artifacts: taskResults.artifacts,
        usage: taskResults.usage,
        warnings: taskResults.warnings,
        failure: taskResults.failure,
      })
      .from(taskResults)
      .where(
        inArray(
          taskResults.taskId,
          tasks.map(({ id }) => id),
        ),
      )
      .orderBy(desc(taskResults.attempt));
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const settled = new Map<string, SettledTask>();
    for (const row of rows) {
      if (settled.has(row.taskId) || (row.status !== 'succeeded' && row.status !== 'failed')) {
        continue;
      }
      const task = byId.get(row.taskId);
      if (!task) continue;
      settled.set(row.taskId, {
        ...task,
        status: row.status,
        summary: row.summary,
        artifacts: decodePersistedArtifacts(row.artifacts),
        usage: row.usage as RuntimeUsage,
        warnings: row.warnings,
        ...(typeof row.failure?.message === 'string' ? { failure: row.failure.message } : {}),
      });
    }
    return settled;
  }
}

function decodePersistedArtifacts(value: readonly unknown[]): readonly StructuredArtifact[] {
  return value.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return [];
    const item = candidate as Record<string, unknown>;
    if (
      !artifactTypes.includes(item.type as ArtifactType) ||
      typeof item.title !== 'string' ||
      typeof item.summary !== 'string' ||
      typeof item.content !== 'object' ||
      item.content === null
    ) {
      return [];
    }
    return [
      {
        type: item.type as ArtifactType,
        title: item.title,
        summary: item.summary,
        content: item.content as Readonly<Record<string, unknown>>,
        evidenceIds: Array.isArray(item.evidenceIds)
          ? item.evidenceIds.filter((id): id is string => typeof id === 'string')
          : [],
      },
    ];
  });
}

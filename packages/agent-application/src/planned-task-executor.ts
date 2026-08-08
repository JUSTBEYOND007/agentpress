import type {
  RuntimeCurrentTurn,
  RuntimeTool,
  RuntimeTranscriptMessage,
} from '@agentpress/agent-runtime';
import {
  agentTasks,
  appendRunEvent,
  claimAgentTask,
  contextPacks,
  releaseAgentTaskLease,
  toolCalls,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { researchExecutionPolicy } from '@agentpress/web-research';

import { AgentSessionRunner } from './agent-session-runner.js';
import { AgentTaskWaitService } from './agent-task-wait-service.js';
import { AgentTranscriptProjector } from './agent-transcript-projector.js';
import type { RunEventPublisher, RuntimeToolFactory } from './contracts.js';
import {
  specialistApplicationTurn,
  specialistPrompt,
  taskCompleteSchemaForRole,
  type PlannedTaskSpec,
  type SettledTask,
} from './planned-run-protocol.js';
import { findAssistant, staleTaskSettlement } from './planned-run-results.js';
import { settledTaskFromFact } from './planned-task-result-projection.js';
import { toDurableEvent } from './run-projection-service.js';
import { parseSpecialistTaskRequest, type SpecialistRole } from './specialist-task-contract.js';
import { SpecialistResultStore } from './specialist-result-store.js';
import {
  SpecialistSubmissionError,
  validateSpecialistSubmission,
  type ValidatedSpecialistSubmission,
} from './specialist-submission-validator.js';

const INLINE_TASK_TIMEOUT_MS = 120_000;
const DETACHED_TASK_WAIT_TIMEOUT_MS = 10 * 60_000;
const TASK_LEASE_GRACE_MS = 30_000;
const RESEARCH_TASK_POLICY = researchExecutionPolicy('deep');

type PlannedTaskExecutorOptions = {
  readonly database: AgentPressDatabase;
  readonly publisher: RunEventPublisher;
  readonly sessions: AgentSessionRunner;
  readonly transcripts: AgentTranscriptProjector;
  readonly taskWaits: AgentTaskWaitService;
  readonly results: SpecialistResultStore;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly inlineTaskTimeoutMs?: number;
  readonly detachedTaskWaitTimeoutMs?: number;
  readonly runtimeToolFactory?: RuntimeToolFactory;
};

export class PlannedTaskExecutor {
  private readonly detachedTaskWaitTimeoutMs: number;

  public constructor(private readonly options: PlannedTaskExecutorOptions) {
    assertTaskTimeout(options.inlineTaskTimeoutMs ?? INLINE_TASK_TIMEOUT_MS);
    this.detachedTaskWaitTimeoutMs =
      options.detachedTaskWaitTimeoutMs ?? DETACHED_TASK_WAIT_TIMEOUT_MS;
    assertTaskTimeout(this.detachedTaskWaitTimeoutMs);
  }

  public async executeDetached(
    runId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'not_found'> {
    const row = await this.options.database
      .select({
        id: agentTasks.id,
        owner: agentTasks.owner,
        objective: agentTasks.objective,
        criticality: agentTasks.criticality,
        acceptanceCriteria: agentTasks.acceptanceCriteria,
        toolPolicy: agentTasks.toolPolicy,
        context: contextPacks.content,
      })
      .from(agentTasks)
      .leftJoin(contextPacks, eq(contextPacks.taskId, agentTasks.id))
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.runId, runId)))
      .limit(1);
    const persisted = row[0];
    if (!persisted || typeof persisted.context !== 'string') return 'not_found';
    const request = parseSpecialistTaskRequest(persisted.toolPolicy.request);
    if (!request?.detached) return 'skipped';
    let envelope: { readonly rootRequest?: RuntimeCurrentTurn };
    try {
      envelope = JSON.parse(persisted.context) as { readonly rootRequest?: RuntimeCurrentTurn };
    } catch {
      return 'failed';
    }
    if (!envelope.rootRequest) return 'failed';
    const task: PlannedTaskSpec = {
      id: persisted.id,
      clientKey: persisted.id,
      owner: persisted.owner as SpecialistRole,
      objective: persisted.objective,
      criticality: persisted.criticality,
      acceptanceCriteria: persisted.acceptanceCriteria,
      dependencyIds: [],
      capabilities: request.capabilities,
      detached: true,
    };
    const claim = await this.claimTaskAttempt(
      runId,
      task,
      request.timeoutMs,
      `task:${String(process.pid)}`,
    );
    if (!claim) return 'skipped';
    const execution = taskExecutionSignal(signal, request.timeoutMs);
    try {
      const result = await this.execute(
        runId,
        task,
        envelope.rootRequest,
        new Map(),
        claim.claim.attempt,
        execution.signal,
        execution.didTimeout,
      );
      return result.status;
    } finally {
      await releaseAgentTaskLease(this.options.database, {
        leaseToken: claim.claim.lease.leaseToken,
        workerId: claim.claim.lease.workerId,
        now: this.options.now(),
      });
    }
  }

  public async executeInline(
    runId: string,
    task: PlannedTaskSpec,
    rootPrompt: RuntimeCurrentTurn,
    settled: ReadonlyMap<string, SettledTask>,
    signal?: AbortSignal,
  ): Promise<SettledTask> {
    const timeoutMs = this.options.inlineTaskTimeoutMs ?? INLINE_TASK_TIMEOUT_MS;
    const claim = await this.claimTaskAttempt(
      runId,
      task,
      timeoutMs,
      `planned:${String(process.pid)}`,
    );
    if (!claim) {
      return {
        ...task,
        status: 'failed',
        artifacts: [],
        warnings: [],
        failure: 'attempt_budget_exhausted',
      };
    }
    const execution = taskExecutionSignal(signal, timeoutMs);
    try {
      return await this.execute(
        runId,
        task,
        rootPrompt,
        settled,
        claim.claim.attempt,
        execution.signal,
        execution.didTimeout,
      );
    } finally {
      await releaseAgentTaskLease(this.options.database, {
        leaseToken: claim.claim.lease.leaseToken,
        workerId: claim.claim.lease.workerId,
        now: this.options.now(),
      });
    }
  }

  public async waitForDetached(
    runId: string,
    task: PlannedTaskSpec,
    signal?: AbortSignal,
  ): Promise<SettledTask> {
    let waited;
    try {
      waited = await this.options.taskWaits.waitForAny({
        runId,
        taskIds: [task.id],
        timeoutMs: this.detachedTaskWaitTimeoutMs,
        pollIntervalMs: 250,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (!signal?.aborted) throw error;
      return {
        ...task,
        status: 'cancelled',
        artifacts: [],
        warnings: [],
        failure: 'run_cancelled',
      };
    }
    const result = waited.settled[0];
    if (result && !waited.timedOut) return settledTaskFromFact(task, result);

    const timedOut: SettledTask = {
      ...task,
      status: 'failed',
      artifacts: [],
      warnings: [],
      failure: 'detached_task_timeout',
    };
    const current = await this.options.database
      .select({ attempt: agentTasks.attempt, status: agentTasks.status })
      .from(agentTasks)
      .where(and(eq(agentTasks.id, task.id), eq(agentTasks.runId, runId)))
      .limit(1);
    const active = current[0];
    const canPersistTimeout =
      (active?.status === 'running' && active.attempt > 0) ||
      ((active?.status === 'pending' || active?.status === 'ready') && active.attempt === 0);
    if (canPersistTimeout) {
      if (await this.options.results.persistTaskResult(runId, timedOut, active.attempt)) {
        return timedOut;
      }
      const raced = await this.options.taskWaits.waitForAny({
        runId,
        taskIds: [task.id],
        timeoutMs: 0,
      });
      if (raced.settled[0]) return settledTaskFromFact(task, raced.settled[0]);
    }
    return timedOut;
  }

  private async execute(
    runId: string,
    task: PlannedTaskSpec,
    rootPrompt: RuntimeCurrentTurn,
    settled: ReadonlyMap<string, SettledTask>,
    attempt: number,
    signal?: AbortSignal,
    didTimeout: () => boolean = () => false,
  ): Promise<SettledTask> {
    let completion: ValidatedSpecialistSubmission | undefined;
    let submissionFailure: SpecialistSubmissionError['code'] | undefined;
    const taskCompleteSchema = taskCompleteSchemaForRole(task.owner);
    const taskComplete: RuntimeTool = {
      name: 'task_complete',
      label: 'Complete specialist task',
      description:
        'Submit the validated specialist result. This is the only valid completion path.',
      parameters: taskCompleteSchema,
      constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      executionMode: 'sequential',
      terminateOnSuccess: true,
      execute: async (arguments_) => {
        try {
          completion = await validateSpecialistSubmission({
            schema: taskCompleteSchema,
            value: arguments_,
            role: task.owner,
            resolveEvidenceProviderRevision: (ids) =>
              this.options.results.resolveTaskEvidenceProviderRevision(runId, task.id, ids),
            assertEvidence: (ids) => this.options.results.assertTaskEvidence(runId, task.id, ids),
          });
          return { accepted: true };
        } catch (error) {
          if (error instanceof SpecialistSubmissionError) submissionFailure = error.code;
          throw error;
        }
      },
    };
    const domainTools = this.options.runtimeToolFactory
      ? await this.options.runtimeToolFactory.createForRun(
          runId,
          task.capabilities,
          task.id,
          attempt,
        )
      : [];
    const upstream = task.dependencyIds.flatMap((id) => {
      const dependency = settled.get(id);
      return dependency
        ? [{ taskId: id, status: dependency.status, summary: dependency.summary }]
        : [];
    });
    const recoveredHistory = await this.loadApprovedToolContinuation(runId, task.id);
    const runtimeLimits = task.capabilities.includes('web.research')
      ? {
          maxToolCalls: RESEARCH_TASK_POLICY.maxQueries,
          maxOutputTokens: RESEARCH_TASK_POLICY.maxSynthesisTokens,
        }
      : undefined;
    const immutableTaskContext = JSON.stringify({
      task: {
        id: task.id,
        owner: task.owner,
        objective: task.objective,
        acceptanceCriteria: task.acceptanceCriteria,
        capabilities: task.capabilities,
      },
      upstream,
    });
    let result = recoveredHistory
      ? await this.options.sessions.execute(
          runId,
          task.id,
          'specialist',
          2,
          task.owner,
          specialistPrompt(task.owner),
          recoveredHistory,
          specialistApplicationTurn(rootPrompt, ''),
          [...domainTools, taskComplete],
          signal,
          true,
          runtimeLimits,
        )
      : await this.options.sessions.execute(
          runId,
          task.id,
          'specialist',
          1,
          task.owner,
          specialistPrompt(task.owner),
          [],
          specialistApplicationTurn(rootPrompt, immutableTaskContext),
          [...domainTools, taskComplete],
          signal,
          false,
          runtimeLimits,
        );
    for (let repair = 1; !completion && result.status !== 'cancelled' && repair <= 2; repair += 1) {
      result = await this.options.sessions.execute(
        runId,
        task.id,
        'specialist',
        (recoveredHistory ? 2 : 1) + repair,
        task.owner,
        specialistPrompt(task.owner),
        [],
        specialistApplicationTurn(
          rootPrompt,
          `${immutableTaskContext}\n\nProtocol repair: call task_complete exactly once with a schema-valid result. Preserve the Task Brief above. evidenceIds may contain only EvidenceRecord UUIDs produced by this task; use [] when none exist.`,
        ),
        [...domainTools, taskComplete],
        signal,
        false,
        runtimeLimits,
      );
    }
    const assistant = findAssistant(result);
    if (!completion) {
      const timedOut = didTimeout();
      const failed: SettledTask = {
        ...task,
        status: timedOut ? 'failed' : result.status === 'cancelled' ? 'cancelled' : 'failed',
        artifacts: [],
        warnings: [],
        failure: timedOut
          ? 'task_timeout'
          : (submissionFailure ??
            (result.status === 'failed' ? result.error.code : 'protocol_error')),
        ...(assistant ? { usage: assistant.usage } : {}),
      };
      return (await this.options.results.persistTaskResult(runId, failed, attempt))
        ? failed
        : staleTaskSettlement(task);
    }
    const taskResult: SettledTask = {
      ...task,
      status: completion.status,
      summary: completion.summary,
      artifacts: completion.artifacts,
      warnings: completion.warnings,
      ...(completion.failure ? { failure: completion.failure } : {}),
      ...(assistant ? { usage: assistant.usage } : {}),
    };
    return (await this.options.results.persistTaskResult(runId, taskResult, attempt))
      ? taskResult
      : staleTaskSettlement(task);
  }

  private async claimTaskAttempt(
    runId: string,
    task: PlannedTaskSpec,
    timeoutMs: number,
    workerId: string,
  ) {
    const result = await this.options.database.transaction(async (transaction) => {
      const claim = await claimAgentTask(transaction, {
        taskId: task.id,
        workerId,
        leaseId: this.options.createId(),
        leaseToken: this.options.createId(),
        leaseMs: timeoutMs + TASK_LEASE_GRACE_MS,
        now: this.options.now(),
      });
      if (!claim) return undefined;
      const event = await appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: 'task.started',
        payload: {
          taskId: task.id,
          owner: task.owner,
          criticality: task.criticality,
          attempt: claim.attempt,
        },
      });
      return { claim, event };
    });
    if (result) {
      await this.options.publisher.publish({ durable: true, event: toDurableEvent(result.event) });
    }
    return result;
  }

  private async loadApprovedToolContinuation(
    runId: string,
    taskId: string,
  ): Promise<readonly RuntimeTranscriptMessage[] | undefined> {
    const callRows = await this.options.database
      .select({ providerToolCallId: toolCalls.providerToolCallId })
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.runId, runId),
          eq(toolCalls.taskId, taskId),
          inArray(toolCalls.status, ['approved', 'succeeded', 'denied', 'expired']),
        ),
      )
      .orderBy(desc(toolCalls.createdAt))
      .limit(1);
    const providerToolCallId = callRows[0]?.providerToolCallId;
    if (!providerToolCallId) return undefined;
    const message = await this.options.transcripts.restoreApprovedToolCall(
      runId,
      taskId,
      providerToolCallId,
    );
    if (!message) return undefined;
    const toolResult = await this.options.runtimeToolFactory?.resumeApprovedToolCall?.(
      runId,
      taskId,
      providerToolCallId,
    );
    if (!toolResult) return undefined;
    return [message, toolResult];
  }
}

function taskExecutionSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: parent ? AbortSignal.any([parent, timeout]) : timeout,
    didTimeout: () => timeout.aborted && parent?.aborted !== true,
  };
}

function assertTaskTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
    throw new RangeError('Specialist Task timeout must be between 1 ms and 10 minutes');
  }
}

import { randomUUID } from 'node:crypto';

import type {
  RuntimeEvent,
  RuntimeMessage,
  RuntimeCurrentTurn,
  RuntimeResult,
  RuntimeTool,
} from '@agentpress/agent-runtime';
import {
  agentRuns,
  appendCheckpoint,
  appendRunEvent,
  type AgentPressDatabase,
  executionPlans,
  planRevisions,
  initializeRunSpecialistBudget,
} from '@agentpress/database';
import { Type } from '@sinclair/typebox';
import { and, eq, sql } from 'drizzle-orm';

import type {
  AgentRuntimeFactory,
  DurableRunEvent,
  RunEventPublisher,
  RuntimeToolFactory,
} from './contracts.js';
import { withArticleOutcomeReceipt } from './outcome-receipt.js';
import { AgentTranscriptProjector } from './agent-transcript-projector.js';
import { AgentSessionRunner } from './agent-session-runner.js';
import { ActionProposalService } from './action-proposal-service.js';
import { AgentTaskWaitService } from './agent-task-wait-service.js';
import type { AgentTurnProfile } from './agent-turn-profile.js';
import {
  mainCompletionPrompt,
  type PlannedTaskSpec,
  type SettledTask,
  type SubmittedPlan,
  PLANNED_DAG_MAX_ESTIMATED_TOKENS,
} from './planned-run-protocol.js';
import { PlannedRunStore } from './planned-run-store.js';
import { SpecialistResultStore } from './specialist-result-store.js';
import { PlannedTaskExecutor } from './planned-task-executor.js';
import { PlanRevisionService } from './plan-revision-service.js';
import { PlannedDagScheduler } from './planned-dag-scheduler.js';
import { MainControlService } from './main-control-service.js';
import {
  applicationTurn,
  confirmedArticleEditPlan,
  emptyUsage,
  findAssistant,
  protocolFailure,
  publicTask,
  requiredTaskFailure,
  terminalProductionResult,
} from './planned-run-results.js';
import { toDurableEvent } from './run-projection-service.js';

export { mainPlanningPrompt, validateSubmittedPlan } from './planned-run-protocol.js';
export { specialistApplicationTurn } from './planned-run-protocol.js';
export type { PlannedTaskSpec } from './planned-run-protocol.js';

export type PlannedExecutionOutcome = {
  readonly result: RuntimeResult;
  readonly degraded: boolean;
  readonly failureStage?: 'synthesis';
};

type PlannedRunExecutorOptions = {
  readonly database: AgentPressDatabase;
  readonly runtimeFactory: AgentRuntimeFactory;
  readonly publisher: RunEventPublisher;
  readonly systemPrompt: string;
  readonly runtimeToolFactory?: RuntimeToolFactory;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly maxSpecialistConcurrency?: number;
  readonly taskTimeoutMs?: number;
  readonly detachedTaskWaitTimeoutMs?: number;
  readonly maxSpecialistTokens?: number;
  /** Global provider ceiling applied in addition to the Specialist wave limit. */
  readonly maxProviderConcurrency?: number;
};

export class PlannedRunExecutor {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly transcripts: AgentTranscriptProjector;
  private readonly sessions: AgentSessionRunner;
  private readonly actionProposals: ActionProposalService;
  private readonly taskWaits: AgentTaskWaitService;
  private readonly store: PlannedRunStore;
  private readonly results: SpecialistResultStore;
  private readonly tasks: PlannedTaskExecutor;
  private readonly revisions: PlanRevisionService;
  private readonly scheduler: PlannedDagScheduler;
  private readonly mainControl: MainControlService;

  public constructor(private readonly options: PlannedRunExecutorOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.transcripts = new AgentTranscriptProjector(options.database, this.now);
    this.sessions = new AgentSessionRunner({
      database: options.database,
      runtimeFactory: options.runtimeFactory,
      createId: this.createId,
      now: this.now,
      onRuntimeEvent: (runId, event) => this.publishRuntimeEvent(runId, event),
    });
    this.actionProposals = new ActionProposalService(
      options.database,
      options.publisher,
      this.now,
      this.createId,
    );
    this.taskWaits = new AgentTaskWaitService(options.database);
    this.store = new PlannedRunStore({
      database: options.database,
      publisher: options.publisher,
      createId: this.createId,
      now: this.now,
    });
    this.results = new SpecialistResultStore({
      database: options.database,
      publisher: options.publisher,
      createId: this.createId,
      now: this.now,
    });
    this.tasks = new PlannedTaskExecutor({
      database: options.database,
      publisher: options.publisher,
      sessions: this.sessions,
      transcripts: this.transcripts,
      taskWaits: this.taskWaits,
      results: this.results,
      createId: this.createId,
      now: this.now,
      ...(options.taskTimeoutMs !== undefined
        ? { inlineTaskTimeoutMs: options.taskTimeoutMs }
        : {}),
      ...(options.detachedTaskWaitTimeoutMs !== undefined
        ? { detachedTaskWaitTimeoutMs: options.detachedTaskWaitTimeoutMs }
        : {}),
      ...(options.runtimeToolFactory ? { runtimeToolFactory: options.runtimeToolFactory } : {}),
    });
    this.revisions = new PlanRevisionService({
      database: options.database,
      publisher: options.publisher,
      sessions: this.sessions,
      store: this.store,
      createId: this.createId,
      now: this.now,
      ...(options.runtimeToolFactory ? { runtimeToolFactory: options.runtimeToolFactory } : {}),
    });
    this.scheduler = new PlannedDagScheduler({
      tasks: this.tasks,
      results: this.results,
      revisions: this.revisions,
      ...(options.maxSpecialistConcurrency
        ? { maxSpecialistConcurrency: options.maxSpecialistConcurrency }
        : {}),
      ...(options.maxProviderConcurrency
        ? { maxProviderConcurrency: options.maxProviderConcurrency }
        : {}),
    });
    this.mainControl = new MainControlService({
      database: options.database,
      sessions: this.sessions,
      actionProposals: this.actionProposals,
      createId: this.createId,
      ...(options.runtimeToolFactory ? { runtimeToolFactory: options.runtimeToolFactory } : {}),
    });
  }

  public steerActiveMain(runId: string, content: string): boolean {
    return this.sessions.steerActiveMain(runId, content);
  }

  public executeDetachedTask(
    runId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'not_found'> {
    return this.tasks.executeDetached(runId, taskId, signal);
  }

  public async execute(
    runId: string,
    turn: RuntimeCurrentTurn,
    history: readonly RuntimeMessage[] = [],
    signal?: AbortSignal,
  ): Promise<PlannedExecutionOutcome | undefined> {
    if (!(await this.store.claimPlanning(runId, 'queued'))) return undefined;
    const profile = await this.createTurnProfile(runId, turn);
    if (profile.kind === 'confirmed_article_edit') {
      return this.persistAndExecutePlan(
        runId,
        turn,
        confirmedArticleEditPlan(turn, profile, this.createId),
        signal,
      );
    }
    const control = await this.runMainControl(runId, turn, profile, history, signal);
    if (control.kind === 'direct') {
      await this.store.enterRunning(runId, 'direct');
      return { result: control.result, degraded: false };
    }
    if (control.kind === 'question') {
      await this.store.persistQuestion(runId, control.question, control.options);
      return undefined;
    }
    return this.persistAndExecutePlan(runId, turn, control.plan, signal);
  }

  public async recover(
    runId: string,
    turn: RuntimeCurrentTurn,
    history: readonly RuntimeMessage[] = [],
    signal?: AbortSignal,
  ): Promise<PlannedExecutionOutcome | undefined> {
    await this.transcripts.interruptActive(runId);
    const rows = await this.options.database
      .select({ mode: agentRuns.mode, revisionId: agentRuns.activePlanRevisionId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'recovering')))
      .limit(1);
    const run = rows[0];
    if (!run) return undefined;
    if (!run.revisionId || run.mode === 'direct') {
      if (!(await this.store.claimPlanning(runId, 'recovering'))) return undefined;
      const profile = await this.createTurnProfile(runId, turn);
      if (profile.kind === 'confirmed_article_edit') {
        return this.persistAndExecutePlan(
          runId,
          turn,
          confirmedArticleEditPlan(turn, profile, this.createId),
          signal,
        );
      }
      const control = await this.runMainControl(runId, turn, profile, history, signal);
      if (control.kind === 'direct') {
        await this.store.enterRunning(runId, 'direct');
        return { result: control.result, degraded: false };
      }
      if (control.kind === 'question') {
        await this.store.persistQuestion(runId, control.question, control.options);
        return undefined;
      }
      return this.persistAndExecutePlan(runId, turn, control.plan, signal);
    }
    const tasks = await this.store.loadPlanTasks(runId, run.revisionId);
    const settled = await this.store.loadPersistedTaskResults(tasks);
    await this.options.database.transaction((transaction) =>
      initializeRunSpecialistBudget(transaction, {
        runId,
        maxTokens: this.options.maxSpecialistTokens ?? PLANNED_DAG_MAX_ESTIMATED_TOKENS,
      }),
    );
    await this.store.enterRunning(runId, 'planned');
    return this.executePlannedWork(runId, turn, tasks, signal, settled);
  }

  private runMainControl(
    runId: string,
    turn: RuntimeCurrentTurn,
    profile: AgentTurnProfile,
    history: readonly RuntimeMessage[],
    signal?: AbortSignal,
  ) {
    return this.mainControl.run(runId, turn, profile, history, signal);
  }

  private createTurnProfile(runId: string, turn: RuntimeCurrentTurn): Promise<AgentTurnProfile> {
    return this.mainControl.createTurnProfile(runId, turn);
  }

  private async persistAndExecutePlan(
    runId: string,
    prompt: RuntimeCurrentTurn,
    plan: SubmittedPlan,
    signal?: AbortSignal,
  ): Promise<PlannedExecutionOutcome> {
    const planId = this.createId();
    const revisionId = this.createId();
    const events = await this.options.database.transaction(async (transaction) => {
      await transaction.insert(executionPlans).values({ id: planId, runId });
      await initializeRunSpecialistBudget(transaction, {
        runId,
        maxTokens: this.options.maxSpecialistTokens ?? PLANNED_DAG_MAX_ESTIMATED_TOKENS,
      });
      await transaction.insert(planRevisions).values({
        id: revisionId,
        planId,
        revisionNumber: 1,
        reason: 'main_agent',
        summary: plan.goal,
      });
      await transaction
        .update(agentRuns)
        .set({
          mode: 'planned',
          activePlanRevisionId: revisionId,
          updatedAt: this.now(),
          version: sql`${agentRuns.version} + 1`,
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'planning')));
      await this.store.persistRevisionTasks(transaction, runId, revisionId, plan.tasks, prompt);
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'plan_revised',
        state: { planId, revisionId, revisionNumber: 1 },
      });
      const planned = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'plan.revised',
        payload: {
          planId,
          revisionId,
          revisionNumber: 1,
          summary: plan.goal,
          tasks: plan.tasks.map(publicTask),
        },
      });
      await transaction
        .update(agentRuns)
        .set({ status: 'running', updatedAt: this.now(), version: sql`${agentRuns.version} + 1` })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'planning')));
      const started = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.started',
        payload: { mode: 'planned', revisionId },
      });
      return [planned, started].map(toDurableEvent);
    });
    await this.publishAll(events);
    return this.executePlannedWork(runId, prompt, plan.tasks, signal);
  }

  private async executePlannedWork(
    runId: string,
    prompt: RuntimeCurrentTurn,
    tasks: readonly PlannedTaskSpec[],
    signal?: AbortSignal,
    initialSettled: ReadonlyMap<string, SettledTask> = new Map(),
  ): Promise<PlannedExecutionOutcome> {
    const settled = await this.scheduler.execute(runId, tasks, prompt, signal, initialSettled);
    if (signal?.aborted || settled.some(({ status }) => status === 'cancelled')) {
      return { degraded: false, result: { status: 'cancelled', messages: [] } };
    }
    const requiredFailure = settled.find(
      (task) => task.criticality === 'required' && task.status !== 'succeeded',
    );
    if (requiredFailure) {
      return {
        degraded: false,
        result: requiredTaskFailure(requiredFailure),
      };
    }
    if (tasks.length === 1 && tasks[0]?.clientKey === 'confirmed-article-edit') {
      return { result: terminalProductionResult(settled[0], this.now()), degraded: false };
    }
    const completion = await this.runCompletionMain(runId, prompt, settled, signal);
    const result = withArticleOutcomeReceipt(
      completion,
      settled.flatMap(({ artifacts }) => artifacts),
    );
    return {
      result,
      degraded: settled.some(({ status }) => status !== 'succeeded'),
      ...(result.status === 'failed' ? { failureStage: 'synthesis' as const } : {}),
    };
  }

  private async runCompletionMain(
    runId: string,
    prompt: RuntimeCurrentTurn,
    settled: readonly SettledTask[],
    signal?: AbortSignal,
  ): Promise<RuntimeResult> {
    let finalText: string | undefined;
    const runComplete: RuntimeTool = {
      name: 'run_complete',
      label: 'Complete run',
      description: 'Complete the run using only persisted task results.',
      parameters: Type.Object(
        {
          answer: Type.String({ minLength: 1, maxLength: 100_000 }),
          artifactIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100 }),
          evidenceIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 200 }),
        },
        { additionalProperties: false },
      ),
      constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      executionMode: 'sequential',
      terminateOnSuccess: true,
      execute: async (arguments_) => {
        await this.results.assertRunReferences(
          runId,
          arguments_.artifactIds as readonly string[],
          arguments_.evidenceIds as readonly string[],
        );
        finalText = String(arguments_.answer);
        return { accepted: true };
      },
    };
    const envelope = JSON.stringify(
      settled.map(({ id, owner, status, summary, warnings, failure, artifacts: produced }) => ({
        taskId: id,
        owner,
        status,
        summary,
        warnings,
        failure,
        artifacts: produced.map(({ type, title, summary: artifactSummary }) => ({
          type,
          title,
          summary: artifactSummary,
        })),
      })),
    );
    await this.sessions.enqueueToolChoice(
      runId,
      { type: 'tool', name: 'run_complete' },
      'Complete planned run',
    );
    let result = await this.sessions.execute(
      runId,
      undefined,
      'main',
      2,
      'synthesis',
      mainCompletionPrompt(),
      [],
      applicationTurn(
        prompt,
        JSON.stringify({ rootRequest: prompt, validatedTaskResults: envelope }),
      ),
      [runComplete],
      signal,
    );
    for (let repair = 1; !finalText && result.status === 'completed' && repair <= 2; repair += 1) {
      await this.sessions.enqueueToolChoice(
        runId,
        { type: 'tool', name: 'run_complete' },
        `Repair planned run completion ${String(repair)}`,
      );
      result = await this.sessions.execute(
        runId,
        undefined,
        'main',
        2 + repair,
        'synthesis',
        mainCompletionPrompt(),
        [],
        applicationTurn(
          prompt,
          'Protocol repair: call run_complete exactly once. Do not return a normal text response.',
        ),
        [runComplete],
        signal,
      );
    }
    if (!finalText) return protocolFailure(result.messages, 'Main Agent did not call run_complete');
    const assistant = findAssistant(result);
    return {
      status: 'completed',
      messages: [
        {
          role: 'assistant',
          content: finalText,
          provider: assistant?.provider ?? 'volcengine-ark',
          model: assistant?.model ?? 'main',
          stopReason: 'stop',
          usage: assistant?.usage ?? emptyUsage,
          timestamp: this.now().getTime(),
        },
      ],
    };
  }

  private async publishRuntimeEvent(runId: string, event: RuntimeEvent): Promise<void> {
    if (
      event.type === 'content.delta' ||
      event.type === 'message.started' ||
      event.type === 'turn.started' ||
      event.type === 'tool.updated'
    ) {
      await this.options.publisher.publish({ durable: false, runId, event });
    }
  }

  private async publishAll(events: readonly DurableRunEvent[]): Promise<void> {
    for (const event of events) {
      await this.options.publisher.publish({ durable: true, event });
    }
  }
}

import { createHash, randomUUID } from 'node:crypto';

import type {
  RuntimeAssistantMessage,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeCurrentTurn,
  RuntimeFailure,
  RuntimeResult,
  RuntimeTool,
  RuntimeTranscriptMessage,
  RuntimeUsage,
} from '@agentpress/agent-runtime';
import {
  agentRuns,
  agentTaskDependencies,
  agentTasks,
  appendCheckpoint,
  appendRunEvent,
  artifacts,
  artifactEvidence,
  artifactVersions,
  type AgentPressDatabase,
  contextPacks,
  type DatabaseTransaction,
  executionPlans,
  evidenceRecords,
  editProposals,
  editProposalBatches,
  planRevisionTasks,
  planRevisions,
  runDirectives,
  runQuestions,
  taskBriefs,
  taskResults,
  toolCalls,
  claimAgentTask,
  enqueueOutboxMessage,
  releaseAgentTaskLease,
  settleAgentTaskAttempt,
} from '@agentpress/database';
import { Type } from '@sinclair/typebox';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';

import type {
  AgentRuntimeFactory,
  DurableRunEvent,
  RunEventPublisher,
  RuntimeToolFactory,
} from './contracts.js';
import {
  articleOutcomeReceipt,
  articleOutcomeReceiptFromArtifact,
  withArticleOutcomeReceipt,
} from './outcome-receipt.js';
import { AGENT_RUN_COMMAND_TOPIC, AGENT_TASK_COMMAND_TOPIC } from './contracts.js';
import { AgentTranscriptProjector } from './agent-transcript-projector.js';
import { AgentSessionRunner } from './agent-session-runner.js';
import { ActionProposalService } from './action-proposal-service.js';
import { AgentTaskWaitService } from './agent-task-wait-service.js';
import {
  createAgentTurnProfile,
  selectMainControlTools,
  type AgentTurnProfile,
} from './agent-turn-profile.js';
import {
  createSpecialistTaskRequest,
  assertSpecialistOutputSchema,
  parseSpecialistTaskRequest,
  resolveSpecialistOutputSchema,
  specialistConcurrencyLimit,
  type SpecialistRole,
} from './specialist-task-contract.js';
import {
  artifactTypes,
  assertStrictSchema,
  mainCompletionPrompt,
  mainPlanningPrompt,
  mainRevisionPrompt,
  planRevisionSchema,
  planSubmitSchema,
  specialistApplicationTurn,
  specialistPrompt,
  taskCompleteSchema,
  validateSubmittedPlan as validatePlan,
  type ArtifactType,
  type PlannedTaskSpec,
  type SettledTask,
  type StructuredArtifact,
  type SubmittedPlan,
} from './planned-run-protocol.js';

export {
  mainPlanningPrompt,
  specialistApplicationTurn,
  validateSubmittedPlan,
} from './planned-run-protocol.js';
export type { PlannedTaskSpec } from './planned-run-protocol.js';

type ControlDecision =
  | { readonly kind: 'direct'; readonly result: RuntimeResult }
  | { readonly kind: 'plan'; readonly plan: SubmittedPlan; readonly result: RuntimeResult }
  | { readonly kind: 'question'; readonly question: string; readonly options: readonly string[] };

export type PlannedExecutionOutcome = {
  readonly result: RuntimeResult;
  readonly degraded: boolean;
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
  /** Global provider ceiling applied in addition to the Specialist wave limit. */
  readonly maxProviderConcurrency?: number;
};

const INLINE_TASK_TIMEOUT_MS = 120_000;
const TASK_LEASE_GRACE_MS = 30_000;

export class PlannedRunExecutor {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly transcripts: AgentTranscriptProjector;
  private readonly sessions: AgentSessionRunner;
  private readonly actionProposals: ActionProposalService;
  private readonly taskWaits: AgentTaskWaitService;

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
  }

  public steerActiveMain(runId: string, content: string): boolean {
    return this.sessions.steerActiveMain(runId, content);
  }

  public async executeDetachedTask(
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
    if (!envelope.rootRequest) {
      return 'failed';
    }
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
    try {
      const result = await this.executeTask(
        runId,
        task,
        envelope.rootRequest,
        new Map(),
        claim.claim.attempt,
        signal,
      );
      return result.status;
    } finally {
      await releaseAgentTaskLease(this.options.database, {
        leaseToken: claim.claim.lease.leaseToken,
        workerId: claim.claim.lease.workerId,
        now: this.now(),
      });
    }
  }

  public async execute(
    runId: string,
    turn: RuntimeCurrentTurn,
    history: readonly RuntimeMessage[] = [],
    signal?: AbortSignal,
  ): Promise<PlannedExecutionOutcome | undefined> {
    if (!(await this.claimPlanning(runId, 'queued'))) return undefined;
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
      await this.enterRunning(runId, 'direct');
      return { result: control.result, degraded: false };
    }
    if (control.kind === 'question') {
      await this.persistQuestion(runId, control.question, control.options);
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
      if (!(await this.claimPlanning(runId, 'recovering'))) return undefined;
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
        await this.enterRunning(runId, 'direct');
        return { result: control.result, degraded: false };
      }
      if (control.kind === 'question') {
        await this.persistQuestion(runId, control.question, control.options);
        return undefined;
      }
      return this.persistAndExecutePlan(runId, turn, control.plan, signal);
    }
    const tasks = await this.loadPlanTasks(runId, run.revisionId);
    const settled = await this.loadPersistedTaskResults(tasks);
    await this.enterRunning(runId, 'planned');
    return this.executePlannedWork(runId, turn, tasks, signal, settled);
  }

  private async runMainControl(
    runId: string,
    turn: RuntimeCurrentTurn,
    profile: AgentTurnProfile,
    history: readonly RuntimeMessage[],
    signal?: AbortSignal,
  ): Promise<ControlDecision> {
    const availableCapabilities = profile.allowedCapabilities;
    let submittedPlan: SubmittedPlan | undefined;
    let requestedQuestion:
      | { readonly question: string; readonly options: readonly string[] }
      | undefined;
    const tools: RuntimeTool[] = [
      this.actionProposals.createRuntimeTool(runId),
      {
        name: 'plan_submit',
        label: 'Submit execution plan',
        description:
          'Submit a concrete task DAG only when the authoritative current request needs specialist work or tools.',
        parameters: planSubmitSchema,
        constrainedSampling: { type: 'json_schema', strict: 'require' },
        executionMode: 'sequential',
        terminateOnSuccess: true,
        execute: (arguments_) => {
          submittedPlan = validatePlan(arguments_, availableCapabilities, this.createId);
          return Promise.resolve({ accepted: true, taskCount: submittedPlan.tasks.length });
        },
      },
      {
        name: 'user_request_input',
        label: 'Request user input',
        description: 'Pause only when required business information is missing.',
        parameters: Type.Object(
          {
            question: Type.String({ minLength: 1, maxLength: 2_000 }),
            options: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
              minItems: 2,
              maxItems: 4,
            }),
          },
          { additionalProperties: false },
        ),
        constrainedSampling: { type: 'json_schema', strict: 'require' },
        executionMode: 'sequential',
        terminateOnSuccess: true,
        execute: (arguments_) => {
          requestedQuestion = {
            question: String(arguments_.question),
            options: arguments_.options as readonly string[],
          };
          return Promise.resolve({ accepted: true });
        },
      },
    ];
    const currentTurnTools = selectMainControlTools(profile, tools);
    const articleCapabilities = profile.allowedCapabilities.filter(
      (capability) => capability === 'article.read' || capability === 'article.propose',
    );
    const domainTools =
      profile.kind === 'article_agent' && this.options.runtimeToolFactory
        ? await this.options.runtimeToolFactory.createForRun(runId, articleCapabilities)
        : [];
    const mainTools = [
      ...currentTurnTools,
      ...domainTools.map((tool) => ({
        ...tool,
        ...(tool.label === 'article.propose_edits' ? { terminateOnSuccess: true } : {}),
      })),
    ];
    const result = await this.sessions.execute(
      runId,
      undefined,
      'main',
      1,
      'main',
      mainPlanningPrompt(availableCapabilities, turn.actionEnvelope.source),
      history,
      turn,
      mainTools,
      signal,
    );
    const editRows = await this.options.database
      .select({
        id: editProposals.id,
        operations: editProposals.operations,
        reviewMode: editProposals.reviewMode,
      })
      .from(editProposals)
      .leftJoin(editProposalBatches, eq(editProposalBatches.proposalId, editProposals.id))
      .where(
        and(
          eq(editProposals.status, 'pending'),
          or(eq(editProposals.runId, runId), eq(editProposalBatches.runId, runId)),
        ),
      )
      .limit(1);
    if (editRows[0]) return { kind: 'direct', result: articleEditResult(result, editRows[0]) };
    if (await this.actionProposals.getBySourceRun(runId)) return { kind: 'direct', result };
    if (submittedPlan) return { kind: 'plan', plan: submittedPlan, result };
    if (requestedQuestion) return { kind: 'question', ...requestedQuestion };
    if (result.status === 'failed') return { kind: 'direct', result };
    if (result.status === 'completed' && findAssistant(result)) return { kind: 'direct', result };
    return {
      kind: 'direct',
      result: protocolFailure(result.messages, 'Main Agent returned no valid control decision'),
    };
  }

  private async createTurnProfile(
    runId: string,
    turn: RuntimeCurrentTurn,
  ): Promise<AgentTurnProfile> {
    const capabilities = this.options.runtimeToolFactory
      ? await this.options.runtimeToolFactory.listCapabilities(runId)
      : [];
    return createAgentTurnProfile(turn, capabilities);
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
      await this.persistRevisionTasks(transaction, runId, revisionId, plan.tasks, prompt);
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
    const settled = await this.executeDag(runId, tasks, prompt, signal, initialSettled);
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
    return {
      result: withArticleOutcomeReceipt(
        completion,
        settled.flatMap(({ artifacts }) => artifacts),
      ),
      degraded: settled.some(({ status }) => status !== 'succeeded'),
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
      constrainedSampling: { type: 'json_schema', strict: 'require' },
      executionMode: 'sequential',
      terminateOnSuccess: true,
      execute: async (arguments_) => {
        await this.assertRunReferences(
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

  private async executeDag(
    runId: string,
    tasks: readonly PlannedTaskSpec[],
    rootPrompt: RuntimeCurrentTurn,
    signal?: AbortSignal,
    initialSettled: ReadonlyMap<string, SettledTask> = new Map(),
  ): Promise<readonly SettledTask[]> {
    const settled = new Map(initialSettled);
    const pending = new Map(
      tasks.filter((task) => !settled.has(task.id)).map((task) => [task.id, task]),
    );
    const orderedTasks = [...tasks];
    while (pending.size > 0) {
      if (signal?.aborted) {
        for (const task of pending.values()) {
          settled.set(task.id, {
            ...task,
            status: 'cancelled',
            artifacts: [],
            warnings: [],
            failure: 'run_cancelled',
          });
        }
        break;
      }
      for (const task of [...pending.values()]) {
        if (
          task.dependencyIds.some((id) => {
            const dependency = settled.get(id);
            return dependency && dependency.status !== 'succeeded';
          })
        ) {
          pending.delete(task.id);
          settled.set(task.id, {
            ...task,
            status: 'skipped',
            artifacts: [],
            warnings: [],
            failure: 'dependency_failed',
          });
          await this.updateTaskStatus(runId, task, 'skipped', 'dependency_failed');
        }
      }
      const ready = [...pending.values()]
        .filter((task) => task.dependencyIds.every((id) => settled.get(id)?.status === 'succeeded'))
        .slice(
          0,
          specialistConcurrencyLimit(
            this.options.maxSpecialistConcurrency,
            this.options.maxProviderConcurrency,
          ),
        );
      if (ready.length === 0) {
        if (pending.size === 0) break;
        throw new Error(`Planned Run ${runId} scheduler made no progress`);
      }
      const wave = await Promise.all(
        ready.map((task) =>
          task.detached
            ? this.waitForDetachedTask(runId, task, signal)
            : this.executeInlineTask(runId, task, rootPrompt, settled, signal),
        ),
      );
      for (const task of wave) {
        pending.delete(task.id);
        settled.set(task.id, task);
      }
      const revision = await this.revisePlanAtBoundary(
        runId,
        rootPrompt,
        orderedTasks,
        pending,
        settled,
        signal,
      );
      if (revision) {
        for (const task of [...pending.values()]) {
          if (!revision.retainedTaskIds.has(task.id)) {
            pending.delete(task.id);
            const cancelled: SettledTask = {
              ...task,
              status: 'cancelled',
              artifacts: [],
              warnings: ['Replaced by Main Agent plan revision'],
              failure: 'plan_revised',
            };
            settled.set(task.id, cancelled);
            await this.updateTaskStatus(runId, task, 'skipped', 'plan_revised');
          }
        }
        for (const task of revision.newTasks) {
          orderedTasks.push(task);
          pending.set(task.id, task);
        }
      }
    }
    return orderedTasks.map(
      (task) =>
        settled.get(task.id) ?? {
          ...task,
          status: 'skipped',
          artifacts: [],
          warnings: [],
          failure: 'not_scheduled',
        },
    );
  }

  private async revisePlanAtBoundary(
    runId: string,
    rootPrompt: RuntimeCurrentTurn,
    orderedTasks: readonly PlannedTaskSpec[],
    pending: ReadonlyMap<string, PlannedTaskSpec>,
    settled: ReadonlyMap<string, SettledTask>,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly retainedTaskIds: ReadonlySet<string>;
        readonly newTasks: readonly PlannedTaskSpec[];
      }
    | undefined
  > {
    const directives = await this.options.database
      .select({ id: runDirectives.id, content: runDirectives.content })
      .from(runDirectives)
      .where(
        and(
          eq(runDirectives.runId, runId),
          eq(runDirectives.kind, 'steering'),
          eq(runDirectives.status, 'pending'),
        ),
      )
      .orderBy(asc(runDirectives.sequence));
    if (directives.length === 0) return undefined;
    const revisionRows = await this.options.database
      .select({
        planId: executionPlans.id,
        revisionId: planRevisions.id,
        revisionNumber: planRevisions.revisionNumber,
      })
      .from(agentRuns)
      .innerJoin(planRevisions, eq(planRevisions.id, agentRuns.activePlanRevisionId))
      .innerJoin(executionPlans, eq(executionPlans.id, planRevisions.planId))
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const current = revisionRows[0];
    if (!current || current.revisionNumber >= 4) {
      await this.options.database
        .update(runDirectives)
        .set({ status: 'consumed', appliedAt: this.now() })
        .where(
          inArray(
            runDirectives.id,
            directives.map(({ id }) => id),
          ),
        );
      return undefined;
    }
    const availableCapabilities = this.options.runtimeToolFactory
      ? await this.options.runtimeToolFactory.listCapabilities(runId)
      : [];
    let submitted:
      | {
          readonly goal: string;
          readonly retainedTaskIds: readonly string[];
          readonly tasks: readonly PlannedTaskSpec[];
        }
      | undefined;
    const planRevise: RuntimeTool = {
      name: 'plan_revise',
      label: 'Revise execution plan',
      description:
        'Retain unaffected pending tasks and add only tasks required by the steering input.',
      parameters: planRevisionSchema,
      constrainedSampling: { type: 'json_schema', strict: 'require' },
      executionMode: 'sequential',
      terminateOnSuccess: true,
      execute: (arguments_) => {
        const retainedTaskIds = arguments_.retainedTaskIds as readonly string[];
        if (retainedTaskIds.some((id) => !pending.has(id))) {
          throw new Error('plan_revise can retain only currently pending tasks');
        }
        const plan = validatePlan(
          { goal: arguments_.goal, tasks: arguments_.tasks },
          availableCapabilities,
          this.createId,
        );
        if (retainedTaskIds.length + plan.tasks.length > 12) {
          throw new Error('Revised plan exceeds 12 active tasks');
        }
        submitted = { goal: plan.goal, retainedTaskIds, tasks: plan.tasks };
        return Promise.resolve({ accepted: true });
      },
    };
    const steering = directives.map(({ content }) => content).join('\n');
    const envelope = {
      rootRequest: rootPrompt,
      steering,
      pendingTasks: [...pending.values()].map(publicTask),
      acceptedResults: [...settled.values()]
        .filter(({ status }) => status === 'succeeded')
        .map(({ id, owner, summary, artifacts: produced }) => ({
          taskId: id,
          owner,
          summary,
          artifacts: produced.map(({ type, title, summary: artifactSummary }) => ({
            type,
            title,
            summary: artifactSummary,
          })),
        })),
    };
    let result = await this.sessions.execute(
      runId,
      undefined,
      'main',
      current.revisionNumber + 1,
      'main',
      mainRevisionPrompt(availableCapabilities),
      [],
      applicationTurn(rootPrompt, JSON.stringify(envelope)),
      [planRevise],
      signal,
    );
    for (let repair = 1; !submitted && result.status === 'completed' && repair <= 2; repair += 1) {
      result = await this.sessions.execute(
        runId,
        undefined,
        'main',
        current.revisionNumber + 1 + repair,
        'main',
        mainRevisionPrompt(availableCapabilities),
        [],
        applicationTurn(
          rootPrompt,
          'Protocol repair: call plan_revise exactly once with a schema-valid revision.',
        ),
        [planRevise],
        signal,
      );
    }
    if (!submitted) throw new Error('Main Agent did not call plan_revise for persisted steering');
    const retained = new Set(submitted.retainedTaskIds);
    const revisionId = this.createId();
    const revisionNumber = current.revisionNumber + 1;
    const revisionEvents = await this.options.database.transaction(async (transaction) => {
      await transaction.insert(planRevisions).values({
        id: revisionId,
        planId: current.planId,
        revisionNumber,
        reason: 'steering',
        summary: submitted?.goal ?? '',
      });
      const revisionMembers = orderedTasks.filter(
        ({ id }) => settled.get(id)?.status === 'succeeded' || retained.has(id),
      );
      if (revisionMembers.length > 0) {
        await transaction.insert(planRevisionTasks).values(
          revisionMembers.map((task, position) => ({
            planRevisionId: revisionId,
            taskId: task.id,
            position,
            sourceRevisionId: current.revisionId,
          })),
        );
      }
      await this.persistRevisionTasks(
        transaction,
        runId,
        revisionId,
        submitted?.tasks ?? [],
        rootPrompt,
        revisionMembers.length,
      );
      await transaction
        .update(agentRuns)
        .set({
          activePlanRevisionId: revisionId,
          updatedAt: this.now(),
          version: sql`${agentRuns.version} + 1`,
        })
        .where(eq(agentRuns.id, runId));
      await transaction
        .update(runDirectives)
        .set({ status: 'consumed', appliedAt: this.now() })
        .where(
          inArray(
            runDirectives.id,
            directives.map(({ id }) => id),
          ),
        );
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'plan_revised',
        state: { revisionId, revisionNumber, directiveIds: directives.map(({ id }) => id) },
      });
      const revised = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'plan.revised',
        payload: {
          revisionId,
          revisionNumber,
          summary: submitted?.goal,
          tasks: [...revisionMembers, ...(submitted?.tasks ?? [])].map(publicTask),
        },
      });
      const applied = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'steering.applied',
        payload: { directiveIds: directives.map(({ id }) => id), revisionNumber },
      });
      return [revised, applied].map(toDurableEvent);
    });
    await this.publishAll(revisionEvents);
    return { retainedTaskIds: retained, newTasks: submitted.tasks };
  }

  private async executeTask(
    runId: string,
    task: PlannedTaskSpec,
    rootPrompt: RuntimeCurrentTurn,
    settled: ReadonlyMap<string, SettledTask>,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<SettledTask> {
    let completion:
      | {
          readonly status: 'succeeded' | 'failed';
          readonly summary: string;
          readonly artifacts: readonly StructuredArtifact[];
          readonly warnings: readonly string[];
          readonly failure?: string;
        }
      | undefined;
    const taskComplete: RuntimeTool = {
      name: 'task_complete',
      label: 'Complete specialist task',
      description:
        'Submit the validated specialist result. This is the only valid completion path.',
      parameters: taskCompleteSchema,
      constrainedSampling: { type: 'json_schema', strict: 'require' },
      executionMode: 'sequential',
      terminateOnSuccess: true,
      execute: async (arguments_) => {
        assertStrictSchema(taskCompleteSchema, arguments_, 'task_complete');
        const submitted = arguments_ as typeof completion & {};
        const evidenceIds = submitted.artifacts.flatMap((artifact) => artifact.evidenceIds);
        await this.assertTaskEvidence(runId, task.id, evidenceIds);
        completion = submitted;
        return Promise.resolve({ accepted: true });
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
      ? await this.sessions.execute(
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
        )
      : await this.sessions.execute(
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
        );
    for (let repair = 1; !completion && result.status !== 'cancelled' && repair <= 2; repair += 1) {
      result = await this.sessions.execute(
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
      );
    }
    const assistant = findAssistant(result);
    if (!completion) {
      const failed: SettledTask = {
        ...task,
        status: result.status === 'cancelled' ? 'cancelled' : 'failed',
        artifacts: [],
        warnings: [],
        failure: result.status === 'failed' ? result.error.code : 'protocol_error',
        ...(assistant ? { usage: assistant.usage } : {}),
      };
      return (await this.persistTaskResult(runId, failed, attempt))
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
    return (await this.persistTaskResult(runId, taskResult, attempt))
      ? taskResult
      : staleTaskSettlement(task);
  }

  private async executeInlineTask(
    runId: string,
    task: PlannedTaskSpec,
    rootPrompt: RuntimeCurrentTurn,
    settled: ReadonlyMap<string, SettledTask>,
    signal?: AbortSignal,
  ): Promise<SettledTask> {
    const claim = await this.claimTaskAttempt(
      runId,
      task,
      INLINE_TASK_TIMEOUT_MS,
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
    try {
      return await this.executeTask(runId, task, rootPrompt, settled, claim.claim.attempt, signal);
    } finally {
      await releaseAgentTaskLease(this.options.database, {
        leaseToken: claim.claim.lease.leaseToken,
        workerId: claim.claim.lease.workerId,
        now: this.now(),
      });
    }
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
        leaseId: this.createId(),
        leaseToken: this.createId(),
        leaseMs: timeoutMs + TASK_LEASE_GRACE_MS,
        now: this.now(),
      });
      if (!claim) return undefined;
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
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

  /** Waits on the durable TaskResult produced by a detached worker. */
  private async waitForDetachedTask(
    runId: string,
    task: PlannedTaskSpec,
    signal?: AbortSignal,
  ): Promise<SettledTask> {
    let waited;
    try {
      waited = await this.taskWaits.waitForAny({
        runId,
        taskIds: [task.id],
        timeoutMs: 10 * 60_000,
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
    if (!result || waited.timedOut) {
      return {
        ...task,
        status: 'failed',
        artifacts: [],
        warnings: [],
        failure: 'detached_task_timeout',
      };
    }
    const failure = taskResultFailure(result.failure);
    return {
      ...task,
      status: result.status,
      ...('summary' in result ? { summary: result.summary } : {}),
      artifacts: decodePersistedArtifacts(result.artifacts),
      ...('summary' in result ? { usage: result.usage as RuntimeUsage } : {}),
      warnings: result.warnings,
      ...(failure ? { failure } : {}),
    };
  }

  private async claimPlanning(runId: string, from: 'queued' | 'recovering'): Promise<boolean> {
    const persisted = await this.options.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(agentRuns)
        .set({ status: 'planning', updatedAt: this.now(), version: sql`${agentRuns.version} + 1` })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, from)))
        .returning({ id: agentRuns.id });
      if (rows.length === 0) return undefined;
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.planning',
        payload: { recovered: from === 'recovering' },
      });
    });
    if (!persisted) return false;
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(persisted) });
    return true;
  }

  private async enterRunning(runId: string, mode: 'direct' | 'planned'): Promise<void> {
    const event = await this.options.database.transaction(async (transaction) => {
      await transaction
        .update(agentRuns)
        .set({ status: 'running', updatedAt: this.now(), version: sql`${agentRuns.version} + 1` })
        .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ['planning', 'recovering'])));
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.started',
        payload: { mode },
      });
    });
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
  }

  private async persistQuestion(
    runId: string,
    question: string,
    options: readonly string[],
  ): Promise<void> {
    const event = await this.options.database.transaction(async (transaction) => {
      const questionId = this.createId();
      await transaction
        .insert(runQuestions)
        .values({ id: questionId, runId, prompt: question, options });
      await transaction
        .update(agentRuns)
        .set({
          status: 'waiting_for_user',
          updatedAt: this.now(),
          version: sql`${agentRuns.version} + 1`,
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'planning')));
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'waiting_for_user',
        state: { questionId },
      });
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'user.input_requested',
        payload: { questionId, question, options },
      });
    });
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
  }

  private async persistRevisionTasks(
    transaction: DatabaseTransaction,
    runId: string,
    revisionId: string,
    tasks: readonly PlannedTaskSpec[],
    prompt: RuntimeCurrentTurn,
    positionOffset = 0,
  ): Promise<void> {
    const requests = tasks.map((task) => {
      const contextPackId = this.createId();
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
    if (dependencies.length > 0)
      await transaction.insert(agentTaskDependencies).values(dependencies);
    for (const { task, request } of requests) {
      const content = JSON.stringify({
        rootRequest: specialistApplicationTurn(prompt, ''),
        task,
        specialistTaskRequest: request,
      });
      const contentHash = createHash('sha256').update(content).digest('hex');
      await transaction.insert(taskBriefs).values({
        id: this.createId(),
        taskId: task.id,
        objective: task.objective,
        constraints: ['Use only the immutable Context Pack', 'Return no hidden chain of thought'],
        expectedOutput: taskCompleteSchema,
        contentHash,
      });
      await transaction.insert(contextPacks).values({
        id: request.contextPackId ?? this.createId(),
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
          id: this.createId(),
          aggregateType: 'AgentTask',
          aggregateId: request.taskId,
          topic: AGENT_TASK_COMMAND_TOPIC,
          messageKey: `${runId}:${request.taskId}`,
          payload: {
            command: 'task.execute',
            messageId: this.createId(),
            runId,
            taskId: request.taskId,
          },
          occurredAt: this.now(),
        });
      }
    }
  }

  private async loadPlanTasks(
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

  private async loadPersistedTaskResults(
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
      if (settled.has(row.taskId) || (row.status !== 'succeeded' && row.status !== 'failed'))
        continue;
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
    const message = await this.transcripts.restoreApprovedToolCall(
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

  private async persistTaskResult(
    runId: string,
    result: SettledTask,
    expectedAttempt: number,
  ): Promise<boolean> {
    const event = await this.options.database.transaction(async (transaction) => {
      const now = this.now();
      if (
        !(await settleAgentTaskAttempt(transaction, {
          taskId: result.id,
          attempt: expectedAttempt,
          status: result.status,
          now,
        }))
      )
        return undefined;
      const persistedArtifacts = [];
      for (const artifact of result.artifacts) {
        const artifactId = this.createId();
        const versionId = this.createId();
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
          id: this.createId(),
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
        id: this.createId(),
        runId,
        reason: 'task_settled',
        state: { taskId: result.id, status: result.status },
      });
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
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
        id: this.createId(),
        aggregateType: 'AgentRun',
        aggregateId: runId,
        topic: AGENT_RUN_COMMAND_TOPIC,
        messageKey: runId,
        payload: {
          command: 'run.execute',
          messageId: this.createId(),
          runId,
        },
        occurredAt: this.now(),
      });
      return event;
    });
    if (!event) return false;
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
    return true;
  }

  private async updateTaskStatus(
    runId: string,
    task: PlannedTaskSpec,
    status: 'skipped',
    failure?: string,
  ): Promise<number | undefined> {
    const event = await this.options.database.transaction(async (transaction) => {
      const now = this.now();
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
        id: this.createId(),
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

  private async assertRunReferences(
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

  private async assertTaskEvidence(
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

function confirmedArticleEditPlan(
  turn: RuntimeCurrentTurn,
  profile: AgentTurnProfile,
  createId: () => string,
): SubmittedPlan {
  const payload = turn.actionEnvelope.payload;
  if (!payload) throw new Error('Confirmed article edit is missing its action payload');
  return {
    goal: payload.instruction,
    tasks: [
      {
        id: createId(),
        clientKey: 'confirmed-article-edit',
        owner: 'editor',
        objective: payload.instruction,
        criticality: 'required',
        acceptanceCriteria: [
          'Read the pinned article revision before proposing changes.',
          'Produce a reviewable EditProposal without directly mutating the article.',
        ],
        dependencyIds: [],
        capabilities: profile.allowedCapabilities,
        detached: false,
      },
    ],
  };
}

function terminalProductionResult(task: SettledTask | undefined, now: Date): RuntimeResult {
  if (task?.status !== 'succeeded') {
    return protocolFailure([], 'Confirmed article edit did not produce a successful task result');
  }
  const proposal = task.artifacts.find(({ type }) => type === 'EditProposal');
  const presentation = articleOutcomeReceiptFromArtifact(proposal);
  return {
    status: 'completed',
    messages: [
      {
        role: 'assistant',
        content: proposal?.summary ?? task.summary ?? '文章修改提案已生成，请在正文中审阅。',
        ...(presentation ? { presentation } : {}),
        provider: 'agentpress',
        model: 'durable-production-result',
        stopReason: 'stop',
        usage: emptyUsage,
        timestamp: now.getTime(),
      },
    ],
  };
}

function articleEditResult(
  result: RuntimeResult,
  proposal: {
    readonly id: string;
    readonly operations: readonly unknown[];
    readonly reviewMode: string;
  },
): RuntimeResult {
  if (result.status !== 'completed') return result;
  const source = [...result.messages]
    .reverse()
    .find((message): message is RuntimeAssistantMessage => message.role === 'assistant');
  const assistant: RuntimeAssistantMessage = {
    role: 'assistant',
    content:
      proposal.reviewMode === 'document'
        ? '已在正文中生成一份整篇文章草稿，等待审阅。'
        : `已在正文中生成 ${String(proposal.operations.length)} 处修改，等待审阅。`,
    blocks: [
      {
        type: 'text',
        text:
          proposal.reviewMode === 'document'
            ? '已在正文中生成一份整篇文章草稿，等待审阅。'
            : `已在正文中生成 ${String(proposal.operations.length)} 处修改，等待审阅。`,
      },
    ],
    parts: [],
    presentation: articleOutcomeReceipt(proposal.id),
    provider: source?.provider ?? 'agentpress',
    model: source?.model ?? 'host-terminal',
    stopReason: 'stop',
    usage: source?.usage ?? emptyUsage,
    timestamp: Date.now(),
  };
  return { status: 'completed', messages: [...result.messages, assistant] };
}

function applicationTurn(parent: RuntimeCurrentTurn, request: string): RuntimeCurrentTurn {
  return {
    ...parent,
    source: 'application',
    request,
    timestamp: Date.now(),
  };
}

function protocolFailure(messages: readonly RuntimeMessage[], message: string): RuntimeResult {
  return {
    status: 'failed',
    messages,
    error: { code: 'protocol_error', message, retryable: true },
  };
}

function requiredTaskFailure(task: SettledTask): RuntimeResult {
  const failure = task.failure ?? 'runtime_error';
  const runtimeCodes = new Set([
    'provider_error',
    'invalid_history',
    'protocol_error',
    'runtime_error',
  ]);
  const code = runtimeCodes.has(failure) ? (failure as RuntimeFailure['code']) : 'runtime_error';
  return {
    status: 'failed',
    messages: [],
    error: {
      code,
      message: publicTaskFailureMessage(failure),
      retryable: failure !== 'stale_task_settlement' && failure !== 'attempt_budget_exhausted',
    },
  };
}

function publicTaskFailureMessage(failure: string): string {
  if (failure === 'provider_error') return '模型服务暂时不可用，请稍后重试。';
  if (failure === 'invalid_history') return '运行上下文无法恢复，请重新生成。';
  if (failure === 'protocol_error') return '运行结果未通过完整性校验，请重新生成。';
  if (failure === 'stale_task_settlement' || failure === 'attempt_budget_exhausted')
    return '运行未完成，当前没有可用结果。';
  return '这次处理没有完成，请稍后重试。';
}

function findAssistant(result: RuntimeResult): RuntimeAssistantMessage | undefined {
  return result.messages.findLast(
    (message): message is RuntimeAssistantMessage => message.role === 'assistant',
  );
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
    )
      return [];
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

function taskResultFailure(value: Readonly<Record<string, unknown>> | null): string | undefined {
  if (!value) return undefined;
  if (typeof value.message === 'string') return value.message;
  return typeof value.code === 'string' ? value.code : undefined;
}

function staleTaskSettlement(task: PlannedTaskSpec): SettledTask {
  return {
    ...task,
    status: 'skipped',
    artifacts: [],
    warnings: ['A newer Task attempt or terminal state superseded this worker result.'],
    failure: 'stale_task_settlement',
  };
}

function publicTask(task: PlannedTaskSpec) {
  return {
    id: task.id,
    owner: task.owner,
    objective: task.objective,
    criticality: task.criticality,
    acceptanceCriteria: task.acceptanceCriteria,
    dependencyIds: task.dependencyIds,
    detached: task.detached,
  };
}

const emptyUsage: RuntimeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

function toDurableEvent(event: {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}): DurableRunEvent {
  return { ...event };
}

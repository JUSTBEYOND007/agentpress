import { createHash, randomUUID } from 'node:crypto';

import type {
  RuntimeAssistantMessage,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeResult,
  RuntimeTool,
  RuntimeUsage,
} from '@agentpress/agent-runtime';
import {
  agentRuns,
  agentSessions,
  agentTaskDependencies,
  agentTasks,
  agentTranscriptEntries,
  appendCheckpoint,
  appendRunEvent,
  artifacts,
  artifactVersions,
  type AgentPressDatabase,
  contextPacks,
  conversations,
  type DatabaseTransaction,
  executionPlans,
  planRevisionTasks,
  planRevisions,
  runQuestions,
  taskBriefs,
  taskResults,
} from '@agentpress/database';
import { Type } from '@sinclair/typebox';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type {
  AgentRuntimeFactory,
  DurableRunEvent,
  RunEventPublisher,
  RuntimeToolFactory,
} from './contracts.js';

type SpecialistRole = 'researcher' | 'writer' | 'editor' | 'fact_checker' | 'illustrator';
type TaskCriticality = 'required' | 'optional';
type ArtifactType =
  | 'ResearchBrief'
  | 'Outline'
  | 'ArticleDraft'
  | 'EditProposal'
  | 'ClaimReview'
  | 'ImagePlan'
  | 'AssetProposal';

export type PlannedTaskSpec = {
  readonly id: string;
  readonly clientKey: string;
  readonly owner: SpecialistRole;
  readonly objective: string;
  readonly criticality: TaskCriticality;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyIds: readonly string[];
  readonly capabilities: readonly string[];
};

type SubmittedPlan = {
  readonly goal: string;
  readonly tasks: readonly PlannedTaskSpec[];
};

type StructuredArtifact = {
  readonly type: ArtifactType;
  readonly title: string;
  readonly summary: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly evidenceIds: readonly string[];
};

type SettledTask = PlannedTaskSpec & {
  readonly status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  readonly summary?: string;
  readonly artifacts: readonly StructuredArtifact[];
  readonly usage?: RuntimeUsage;
  readonly warnings: readonly string[];
  readonly failure?: string;
};

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
};

const specialistRoles = [
  'researcher',
  'writer',
  'editor',
  'fact_checker',
  'illustrator',
] as const;
const artifactTypes = [
  'ResearchBrief',
  'Outline',
  'ArticleDraft',
  'EditProposal',
  'ClaimReview',
  'ImagePlan',
  'AssetProposal',
] as const;

const taskSchema = Type.Object(
  {
    clientKey: Type.String({ minLength: 1, maxLength: 80 }),
    owner: Type.Union(specialistRoles.map((value) => Type.Literal(value))),
    objective: Type.String({ minLength: 1, maxLength: 4_000 }),
    criticality: Type.Union([Type.Literal('required'), Type.Literal('optional')]),
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
      minItems: 1,
      maxItems: 8,
    }),
    dependencyKeys: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 12 }),
    capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 16 }),
  },
  { additionalProperties: false },
);

const taskCompleteSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
    summary: Type.String({ minLength: 1, maxLength: 20_000 }),
    artifacts: Type.Array(
      Type.Object(
        {
          type: Type.Union(artifactTypes.map((value) => Type.Literal(value))),
          title: Type.String({ minLength: 1, maxLength: 300 }),
          summary: Type.String({ minLength: 1, maxLength: 4_000 }),
          content: Type.Record(Type.String(), Type.Unknown()),
          evidenceIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 12 },
    ),
    warnings: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 20 }),
    failure: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  },
  { additionalProperties: false },
);

export class PlannedRunExecutor {
  private readonly now: () => Date;
  private readonly createId: () => string;

  public constructor(private readonly options: PlannedRunExecutorOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  public async execute(
    runId: string,
    prompt: string,
    history: readonly RuntimeMessage[] = [],
    signal?: AbortSignal,
  ): Promise<PlannedExecutionOutcome | undefined> {
    if (!(await this.claimPlanning(runId, 'queued'))) return undefined;
    const control = await this.runMainControl(runId, prompt, history, signal);
    if (control.kind === 'direct') {
      await this.enterRunning(runId, 'direct');
      return { result: control.result, degraded: false };
    }
    if (control.kind === 'question') {
      await this.persistQuestion(runId, control.question, control.options);
      return undefined;
    }
    return this.persistAndExecutePlan(runId, prompt, control.plan, signal);
  }

  public async recover(
    runId: string,
    prompt: string,
    history: readonly RuntimeMessage[] = [],
    signal?: AbortSignal,
  ): Promise<PlannedExecutionOutcome | undefined> {
    const rows = await this.options.database
      .select({ mode: agentRuns.mode, revisionId: agentRuns.activePlanRevisionId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'recovering')))
      .limit(1);
    const run = rows[0];
    if (!run) return undefined;
    if (!run.revisionId || run.mode === 'direct') {
      if (!(await this.claimPlanning(runId, 'recovering'))) return undefined;
      const control = await this.runMainControl(runId, prompt, history, signal);
      if (control.kind === 'direct') {
        await this.enterRunning(runId, 'direct');
        return { result: control.result, degraded: false };
      }
      if (control.kind === 'question') {
        await this.persistQuestion(runId, control.question, control.options);
        return undefined;
      }
      return this.persistAndExecutePlan(runId, prompt, control.plan, signal);
    }
    const tasks = await this.loadPlanTasks(runId, run.revisionId);
    await this.enterRunning(runId, 'planned');
    return this.executePlannedWork(runId, prompt, tasks, signal);
  }

  private async runMainControl(
    runId: string,
    prompt: string,
    history: readonly RuntimeMessage[],
    signal?: AbortSignal,
  ): Promise<ControlDecision> {
    const availableCapabilities = this.options.runtimeToolFactory
      ? await this.options.runtimeToolFactory.listCapabilities(runId)
      : [];
    let submittedPlan: SubmittedPlan | undefined;
    let requestedQuestion: { readonly question: string; readonly options: readonly string[] } | undefined;
    const tools: RuntimeTool[] = [
      {
        name: 'plan_submit',
        label: 'Submit execution plan',
        description: 'Submit a concrete task DAG only when the request needs specialist work or tools.',
        parameters: Type.Object(
          {
            goal: Type.String({ minLength: 1, maxLength: 4_000 }),
            tasks: Type.Array(taskSchema, { minItems: 1, maxItems: 12 }),
          },
          { additionalProperties: false },
        ),
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
    const result = await this.executeWithTranscript(
      runId,
      undefined,
      'main',
      1,
      'main',
      mainPlanningPrompt(availableCapabilities),
      history,
      prompt,
      tools,
      signal,
    );
    if (submittedPlan) return { kind: 'plan', plan: submittedPlan, result };
    if (requestedQuestion) return { kind: 'question', ...requestedQuestion };
    if (result.status === 'completed' && findAssistant(result)) return { kind: 'direct', result };
    return {
      kind: 'direct',
      result: protocolFailure(result.messages, 'Main Agent returned no valid control decision'),
    };
  }

  private async persistAndExecutePlan(
    runId: string,
    prompt: string,
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
    prompt: string,
    tasks: readonly PlannedTaskSpec[],
    signal?: AbortSignal,
  ): Promise<PlannedExecutionOutcome> {
    const settled = await this.executeDag(runId, tasks, prompt, signal);
    if (signal?.aborted || settled.some(({ status }) => status === 'cancelled')) {
      return { degraded: false, result: { status: 'cancelled', messages: [] } };
    }
    const requiredFailure = settled.find(
      (task) => task.criticality === 'required' && task.status !== 'succeeded',
    );
    if (requiredFailure) {
      return {
        degraded: false,
        result: protocolFailure([], `Required ${requiredFailure.owner} task failed: ${requiredFailure.failure ?? 'unknown failure'}`),
      };
    }
    const completion = await this.runCompletionMain(runId, prompt, settled, signal);
    return {
      result: completion,
      degraded: settled.some(({ status }) => status !== 'succeeded'),
    };
  }

  private async runCompletionMain(
    runId: string,
    prompt: string,
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
    let result = await this.executeWithTranscript(
      runId,
      undefined,
      'main',
      2,
      'synthesis',
      mainCompletionPrompt(),
      [],
      `Root request:\n${prompt}\n\nValidated Task Result Envelopes:\n${envelope}`,
      [runComplete],
      signal,
    );
    for (let repair = 1; !finalText && result.status === 'completed' && repair <= 2; repair += 1) {
      result = await this.executeWithTranscript(
        runId,
        undefined,
        'main',
        2 + repair,
        'synthesis',
        mainCompletionPrompt(),
        [],
        'Protocol repair: call run_complete exactly once. Do not return a normal text response.',
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
    rootPrompt: string,
    signal?: AbortSignal,
  ): Promise<readonly SettledTask[]> {
    const settled = new Map<string, SettledTask>();
    const pending = new Map(tasks.map((task) => [task.id, task]));
    while (pending.size > 0) {
      if (signal?.aborted) {
        for (const task of pending.values()) {
          settled.set(task.id, { ...task, status: 'cancelled', artifacts: [], warnings: [], failure: 'run_cancelled' });
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
          settled.set(task.id, { ...task, status: 'skipped', artifacts: [], warnings: [], failure: 'dependency_failed' });
          await this.updateTaskStatus(runId, task, 'skipped', 'dependency_failed');
        }
      }
      const ready = [...pending.values()]
        .filter((task) => task.dependencyIds.every((id) => settled.get(id)?.status === 'succeeded'))
        .slice(0, 3);
      if (ready.length === 0) {
        if (pending.size === 0) break;
        throw new Error(`Planned Run ${runId} scheduler made no progress`);
      }
      const wave = await Promise.all(
        ready.map((task) => this.executeTask(runId, task, rootPrompt, settled, signal)),
      );
      for (const task of wave) {
        pending.delete(task.id);
        settled.set(task.id, task);
      }
    }
    return tasks.map(
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

  private async executeTask(
    runId: string,
    task: PlannedTaskSpec,
    rootPrompt: string,
    settled: ReadonlyMap<string, SettledTask>,
    signal?: AbortSignal,
  ): Promise<SettledTask> {
    await this.updateTaskStatus(runId, task, 'running');
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
      description: 'Submit the validated specialist result. This is the only valid completion path.',
      parameters: taskCompleteSchema,
      constrainedSampling: { type: 'json_schema', strict: 'require' },
      executionMode: 'sequential',
      terminateOnSuccess: true,
      execute: (arguments_) => {
        completion = arguments_ as typeof completion & {};
        return Promise.resolve({ accepted: true });
      },
    };
    const domainTools = this.options.runtimeToolFactory
      ? await this.options.runtimeToolFactory.createForRun(runId, task.capabilities, task.id)
      : [];
    const upstream = task.dependencyIds.flatMap((id) => {
      const dependency = settled.get(id);
      return dependency ? [{ taskId: id, status: dependency.status, summary: dependency.summary }] : [];
    });
    let result = await this.executeWithTranscript(
      runId,
      task.id,
      'specialist',
      1,
      task.owner,
      specialistPrompt(task.owner),
      [],
      JSON.stringify({ rootRequest: rootPrompt, task, upstream }),
      [...domainTools, taskComplete],
      signal,
    );
    for (let repair = 1; !completion && result.status === 'completed' && repair <= 2; repair += 1) {
      result = await this.executeWithTranscript(
        runId,
        task.id,
        'specialist',
        repair + 1,
        task.owner,
        specialistPrompt(task.owner),
        [],
        'Protocol repair: call task_complete exactly once with a schema-valid result.',
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
        failure: result.status === 'failed' ? result.error.message : 'protocol_error',
        ...(assistant ? { usage: assistant.usage } : {}),
      };
      await this.persistTaskResult(runId, failed);
      return failed;
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
    await this.persistTaskResult(runId, taskResult);
    return taskResult;
  }

  private async executeWithTranscript(
    runId: string,
    taskId: string | undefined,
    kind: 'main' | 'specialist',
    attempt: number,
    modelPurpose: string,
    systemPrompt: string,
    history: readonly RuntimeMessage[],
    prompt: string,
    tools: readonly RuntimeTool[],
    signal?: AbortSignal,
  ): Promise<RuntimeResult> {
    const sessionId = this.createId();
    await this.options.database.insert(agentSessions).values({
      id: sessionId,
      runId,
      ...(taskId ? { taskId } : {}),
      kind,
      attempt,
      logicalKey: taskId ? `${runId}:task:${taskId}:${attempt}` : `${runId}:main:${attempt}`,
      model: modelPurpose,
    });
    let sequence = 1;
    const record = async (role: string, messageType: string, content: Readonly<Record<string, unknown>>, providerToolCallId?: string) => {
      await this.options.database.insert(agentTranscriptEntries).values({
        id: this.createId(),
        sessionId,
        sequence,
        role,
        messageType,
        content,
        ...(providerToolCallId ? { providerToolCallId } : {}),
      });
      sequence += 1;
    };
    await record('system', 'system_prompt', { content: systemPrompt });
    await record('user', 'prompt', { content: prompt });
    const runtime = this.options.runtimeFactory.create(modelPurpose);
    let result: RuntimeResult;
    try {
      result = await runtime.execute(
        { runId: sessionId, systemPrompt, history, prompt, tools },
        async (event) => {
          if (event.type === 'message.completed') {
            await record(event.message.role, 'message', { message: event.message });
          } else if (event.type === 'tool.started') {
            await record('assistant', 'tool_call', { name: event.toolName, arguments: event.arguments }, event.toolCallId);
          } else if (event.type === 'tool.completed') {
            await record('tool', 'tool_result', { result: event.result }, event.result.toolCallId);
          }
          await this.publishRuntimeEvent(runId, event);
        },
        signal,
      );
    } catch (error) {
      result = protocolFailure([], error instanceof Error ? error.message : 'Unknown Pi runtime error');
    }
    await this.options.database
      .update(agentSessions)
      .set({
        status: result.status === 'completed' ? 'completed' : 'failed',
        nextSequence: sequence,
        updatedAt: this.now(),
      })
      .where(eq(agentSessions.id, sessionId));
    return result;
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

  private async persistQuestion(runId: string, question: string, options: readonly string[]): Promise<void> {
    const event = await this.options.database.transaction(async (transaction) => {
      const questionId = this.createId();
      await transaction.insert(runQuestions).values({ id: questionId, runId, prompt: question, options });
      await transaction
        .update(agentRuns)
        .set({ status: 'waiting_for_user', updatedAt: this.now(), version: sql`${agentRuns.version} + 1` })
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
    prompt: string,
  ): Promise<void> {
    await transaction.insert(agentTasks).values(
      tasks.map((task) => ({
        id: task.id,
        runId,
        planRevisionId: revisionId,
        objective: task.objective,
        criticality: task.criticality,
        owner: task.owner,
        acceptanceCriteria: task.acceptanceCriteria,
        outputSchema: taskCompleteSchema,
        toolPolicy: { capabilities: task.capabilities },
        budget: { maxAttempts: 3, protocolRepairTurns: 2 },
        status: 'pending' as const,
        maxAttempts: 3,
      })),
    );
    await transaction.insert(planRevisionTasks).values(
      tasks.map((task, position) => ({ planRevisionId: revisionId, taskId: task.id, position })),
    );
    const dependencies = tasks.flatMap((task) =>
      task.dependencyIds.map((dependencyTaskId) => ({ taskId: task.id, dependencyTaskId })),
    );
    if (dependencies.length > 0) await transaction.insert(agentTaskDependencies).values(dependencies);
    for (const task of tasks) {
      const content = JSON.stringify({ rootRequest: prompt, task });
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
        id: this.createId(),
        taskId: task.id,
        manifest: { runId, revisionId, taskId: task.id, capabilities: task.capabilities },
        content,
        format: 'json',
        schemaVersion: 1,
        contentHash,
        tokenCount: Math.ceil(content.length / 3),
      });
    }
  }

  private async loadPlanTasks(runId: string, revisionId: string): Promise<readonly PlannedTaskSpec[]> {
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
    return rows.map((row) => ({
      id: row.id,
      clientKey: row.id,
      owner: row.owner as SpecialistRole,
      objective: row.objective,
      criticality: row.criticality,
      acceptanceCriteria: row.acceptanceCriteria,
      dependencyIds: dependencies
        .filter(({ agent_task_dependencies: dependency }) => dependency.taskId === row.id)
        .map(({ agent_task_dependencies: dependency }) => dependency.dependencyTaskId),
      capabilities: Array.isArray(row.toolPolicy.capabilities)
        ? row.toolPolicy.capabilities.filter((value): value is string => typeof value === 'string')
        : [],
    }));
  }

  private async persistTaskResult(runId: string, result: SettledTask): Promise<void> {
    const event = await this.options.database.transaction(async (transaction) => {
      const now = this.now();
      await transaction
        .update(agentTasks)
        .set({
          status: result.status,
          updatedAt: now,
          completedAt: now,
          version: sql`${agentTasks.version} + 1`,
        })
        .where(eq(agentTasks.id, result.id));
      const persistedArtifacts = [];
      for (const artifact of result.artifacts) {
        const artifactId = this.createId();
        const versionId = this.createId();
        const contentHash = createHash('sha256').update(JSON.stringify(artifact.content)).digest('hex');
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
        persistedArtifacts.push({ artifactId, versionId, ...artifact });
      }
      if (result.status !== 'cancelled' && result.status !== 'skipped') {
        await transaction.insert(taskResults).values({
          id: this.createId(),
          taskId: result.id,
          attempt: 1,
          status: result.status,
          artifacts: persistedArtifacts,
          evidence: [],
          usage: result.usage ?? {},
          warnings: result.warnings,
          ...(result.failure ? { failure: { code: result.failure, message: result.failure } } : {}),
        });
      }
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'task_settled',
        state: { taskId: result.id, status: result.status, attempt: 1 },
      });
      return appendRunEvent(transaction, {
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
    });
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
  }

  private async updateTaskStatus(
    runId: string,
    task: PlannedTaskSpec,
    status: 'running' | 'skipped',
    failure?: string,
  ): Promise<void> {
    const event = await this.options.database.transaction(async (transaction) => {
      const now = this.now();
      await transaction
        .update(agentTasks)
        .set({
          status,
          ...(status === 'running' ? { attempt: sql`${agentTasks.attempt} + 1` } : { completedAt: now }),
          updatedAt: now,
          version: sql`${agentTasks.version} + 1`,
        })
        .where(eq(agentTasks.id, task.id));
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: `task.${status === 'running' ? 'started' : 'skipped'}`,
        payload: { taskId: task.id, owner: task.owner, ...(failure ? { failure } : {}) },
      });
    });
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
  }

  private async assertRunReferences(
    runId: string,
    artifactIds: readonly string[],
    evidenceIds: readonly string[],
  ): Promise<void> {
    if (evidenceIds.length > 0) {
      throw new Error('Evidence references are unavailable until evidence is persisted by a tool');
    }
    if (artifactIds.length === 0) return;
    const rows = await this.options.database
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), inArray(artifacts.id, artifactIds)));
    if (new Set(rows.map(({ id }) => id)).size !== new Set(artifactIds).size) {
      throw new Error('run_complete references an artifact outside the current Run');
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

export function validateSubmittedPlan(
  value: Readonly<Record<string, unknown>>,
  availableCapabilities: readonly string[],
  createId: () => string,
): SubmittedPlan {
  const rawTasks = value.tasks as readonly {
    readonly clientKey: string;
    readonly owner: SpecialistRole;
    readonly objective: string;
    readonly criticality: TaskCriticality;
    readonly acceptanceCriteria: readonly string[];
    readonly dependencyKeys: readonly string[];
    readonly capabilities: readonly string[];
  }[];
  const keys = new Set(rawTasks.map(({ clientKey }) => clientKey));
  if (keys.size !== rawTasks.length) throw new Error('Plan task clientKey values must be unique');
  const available = new Set(availableCapabilities);
  for (const task of rawTasks) {
    if (task.dependencyKeys.some((key) => !keys.has(key) || key === task.clientKey)) {
      throw new Error(`Task ${task.clientKey} has an invalid dependency`);
    }
    if (task.capabilities.some((capability) => !available.has(capability))) {
      throw new Error(`Task ${task.clientKey} requested an unauthorized capability`);
    }
  }
  const ids = new Map(rawTasks.map(({ clientKey }) => [clientKey, createId()]));
  const tasks = rawTasks.map((task) => ({
    id: ids.get(task.clientKey) ?? createId(),
    clientKey: task.clientKey,
    owner: task.owner,
    objective: task.objective,
    criticality: task.criticality,
    acceptanceCriteria: [...task.acceptanceCriteria],
    dependencyIds: task.dependencyKeys.map((key) => ids.get(key) ?? ''),
    capabilities: [...task.capabilities],
  }));
  assertAcyclic(tasks);
  return { goal: String(value.goal), tasks };
}

const validatePlan = validateSubmittedPlan;

function assertAcyclic(tasks: readonly PlannedTaskSpec[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Plan contains a dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencyIds ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function mainPlanningPrompt(capabilities: readonly string[]): string {
  return `You are the persistent AgentPress Main Agent. Decide how to handle the user's request.
Return a normal final answer only when no tools or specialist work are needed.
For work requiring tools, research, writing pipeline, article changes, or media, call plan_submit with a concrete minimal DAG.
If required business information is missing, call user_request_input.
Available capabilities: ${JSON.stringify(capabilities)}.
Never emit a generic template plan. Never reveal hidden chain of thought.`;
}

function mainCompletionPrompt(): string {
  return 'You are the AgentPress Main Agent. Synthesize only from validated Task Result Envelopes. You must call run_complete. Do not answer as ordinary text and do not invent Artifact or Evidence IDs.';
}

function specialistPrompt(role: SpecialistRole): string {
  return `You are the AgentPress ${role} Specialist. Work only on the supplied immutable Task Brief. Use only available tools. Submit the final structured result through task_complete and never reveal hidden chain of thought.`;
}

function protocolFailure(messages: readonly RuntimeMessage[], message: string): RuntimeResult {
  return {
    status: 'failed',
    messages,
    error: { code: 'protocol_error', message, retryable: true },
  };
}

function findAssistant(result: RuntimeResult): RuntimeAssistantMessage | undefined {
  return result.messages.findLast(
    (message): message is RuntimeAssistantMessage => message.role === 'assistant',
  );
}

function publicTask(task: PlannedTaskSpec) {
  return {
    id: task.id,
    owner: task.owner,
    objective: task.objective,
    criticality: task.criticality,
    acceptanceCriteria: task.acceptanceCriteria,
    dependencyIds: task.dependencyIds,
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

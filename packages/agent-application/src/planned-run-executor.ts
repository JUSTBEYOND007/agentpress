import { createHash, randomUUID } from 'node:crypto';

import { createPromptRevision, runReviewGate } from '@agentpress/agent-context';
import type {
  RuntimeAssistantMessage,
  RuntimeResult,
  RuntimeUsage,
} from '@agentpress/agent-runtime';
import {
  agentRuns,
  appendCheckpoint,
  agentTaskDependencies,
  agentTasks,
  appendRunEvent,
  type AgentPressDatabase,
  contextPacks,
  type DatabaseTransaction,
  executionPlans,
  planRevisions,
  runDirectives,
  taskBriefs,
  taskResults,
} from '@agentpress/database';
import { and, eq, inArray, max, sql } from 'drizzle-orm';

import type {
  AgentRuntimeFactory,
  DurableRunEvent,
  RunEventPublisher,
  RuntimeToolFactory,
} from './contracts.js';
import { classifyRun } from './run-classifier.js';

type SpecialistRole = 'researcher' | 'writer' | 'editor' | 'fact_checker' | 'illustrator';
type TaskCriticality = 'required' | 'optional';

type PlannedTaskSpec = {
  readonly id: string;
  readonly owner: SpecialistRole;
  readonly objective: string;
  readonly criticality: TaskCriticality;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyIds: readonly string[];
};

type SettledTask = PlannedTaskSpec & {
  readonly status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  readonly output?: string;
  readonly usage?: RuntimeUsage;
  readonly failure?: string;
};

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
  readonly reviewGate?: { readonly enabled: boolean; readonly maxRounds?: number };
  readonly now?: () => Date;
  readonly createId?: () => string;
};

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
    signal?: AbortSignal,
  ): Promise<PlannedExecutionOutcome | undefined> {
    const tasks = buildPlan(prompt, this.createId);
    const planId = this.createId();
    const revisionId = this.createId();
    const planningEvents = await this.options.database.transaction(async (transaction) => {
      const claimed = await transaction
        .update(agentRuns)
        .set({
          status: 'planning',
          updatedAt: this.now(),
          version: sql`${agentRuns.version} + 1`,
        })
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.mode, 'planned'),
            eq(agentRuns.status, 'queued'),
          ),
        )
        .returning({ id: agentRuns.id });
      if (claimed.length === 0) {
        return undefined;
      }

      await transaction.insert(executionPlans).values({ id: planId, runId });
      await transaction.insert(planRevisions).values({
        id: revisionId,
        planId,
        revisionNumber: 1,
        reason: 'initial_plan',
        summary: summarizePlan(tasks),
      });
      await transaction
        .update(agentRuns)
        .set({
          activePlanRevisionId: revisionId,
          updatedAt: this.now(),
          version: sql`${agentRuns.version} + 1`,
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'planning')));
      await this.persistRevisionTasks(transaction, runId, revisionId, tasks, prompt);
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'plan_revised',
        state: { planId, revisionId, revisionNumber: 1 },
      });

      const planning = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.planning',
        payload: {},
      });
      const planCreated = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'plan.revised',
        payload: {
          planId,
          revisionId,
          revisionNumber: 1,
          tasks: tasks.map(publicTask),
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
      return [planning, planCreated, started].map(toDurableEvent);
    });
    if (!planningEvents) {
      return undefined;
    }
    await this.publishAll(planningEvents);

    return this.executePlannedWork(runId, planId, revisionId, 1, tasks, prompt, signal);
  }

  public async recover(
    runId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<PlannedExecutionOutcome | undefined> {
    const tasks = buildPlan(prompt, this.createId);
    const revisionId = this.createId();
    const recovered = await this.options.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          planId: executionPlans.id,
          previousRevisionId: agentRuns.activePlanRevisionId,
        })
        .from(agentRuns)
        .innerJoin(executionPlans, eq(executionPlans.runId, agentRuns.id))
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.mode, 'planned'),
            eq(agentRuns.status, 'recovering'),
          ),
        )
        .limit(1);
      const existing = rows[0];
      if (!existing?.previousRevisionId) {
        return undefined;
      }
      const numbers = await transaction
        .select({ revisionNumber: max(planRevisions.revisionNumber) })
        .from(planRevisions)
        .where(eq(planRevisions.planId, existing.planId));
      const revisionNumber = (numbers[0]?.revisionNumber ?? 0) + 1;
      await transaction.insert(planRevisions).values({
        id: revisionId,
        planId: existing.planId,
        previousRevisionId: existing.previousRevisionId,
        revisionNumber,
        reason: 'worker_recovery',
        summary: summarizePlan(tasks),
      });
      await this.persistRevisionTasks(transaction, runId, revisionId, tasks, prompt);
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'plan_revised',
        state: { planId: existing.planId, revisionId, revisionNumber, recovery: true },
      });
      await transaction
        .update(agentRuns)
        .set({
          activePlanRevisionId: revisionId,
          status: 'running',
          updatedAt: this.now(),
          version: sql`${agentRuns.version} + 1`,
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'recovering')));
      const revised = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'plan.revised',
        payload: {
          planId: existing.planId,
          revisionId,
          previousRevisionId: existing.previousRevisionId,
          revisionNumber,
          reason: 'worker_recovery',
          tasks: tasks.map(publicTask),
        },
      });
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.recovered',
        payload: { mode: 'planned', revisionId },
      });
      return {
        planId: existing.planId,
        revisionNumber,
        events: [revised, event].map(toDurableEvent),
      };
    });
    if (!recovered) {
      return undefined;
    }
    await this.publishAll(recovered.events);
    return this.executePlannedWork(
      runId,
      recovered.planId,
      revisionId,
      recovered.revisionNumber,
      tasks,
      prompt,
      signal,
    );
  }

  private async executePlannedWork(
    runId: string,
    planId: string,
    revisionId: string,
    initialRevisionNumber: number,
    tasks: readonly PlannedTaskSpec[],
    prompt: string,
    signal?: AbortSignal,
  ): Promise<PlannedExecutionOutcome> {
    let activeRevisionId = revisionId;
    let activePrompt = prompt;
    let revisionNumber = initialRevisionNumber;
    let settled = [...(await this.executeDag(runId, revisionId, tasks, prompt, signal))];
    let steering = await this.consumeSteering(runId);
    while (steering && revisionNumber < 4 && !signal?.aborted) {
      const currentSteering = steering;
      revisionNumber += 1;
      activePrompt = `${activePrompt}\n\nSteering instruction:\n${currentSteering.content}`;
      const nextRevisionId = this.createId();
      const revisedTasks = buildPlan(activePrompt, this.createId);
      const revisionEvents = await this.options.database.transaction(async (transaction) => {
        await transaction.insert(planRevisions).values({
          id: nextRevisionId,
          planId,
          previousRevisionId: activeRevisionId,
          revisionNumber,
          reason: 'steering',
          summary: summarizePlan(revisedTasks),
        });
        await this.persistRevisionTasks(
          transaction,
          runId,
          nextRevisionId,
          revisedTasks,
          activePrompt,
        );
        await appendCheckpoint(transaction, {
          id: this.createId(),
          runId,
          reason: 'plan_revised',
          state: { planId, revisionId: nextRevisionId, revisionNumber },
        });
        await transaction
          .update(agentRuns)
          .set({
            activePlanRevisionId: nextRevisionId,
            updatedAt: this.now(),
            version: sql`${agentRuns.version} + 1`,
          })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')));
        await transaction
          .update(runDirectives)
          .set({ status: 'applied', appliedAt: this.now() })
          .where(inArray(runDirectives.id, currentSteering.ids));
        const applied = await appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType: 'steering.applied',
          payload: { directiveIds: currentSteering.ids, revisionNumber },
        });
        const revised = await appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType: 'plan.revised',
          payload: {
            planId,
            revisionId: nextRevisionId,
            previousRevisionId: activeRevisionId,
            revisionNumber,
            tasks: revisedTasks.map(publicTask),
          },
        });
        return [applied, revised].map(toDurableEvent);
      });
      await this.publishAll(revisionEvents);
      settled = [
        ...settled,
        ...(await this.executeDag(runId, nextRevisionId, revisedTasks, activePrompt, signal)),
      ];
      activeRevisionId = nextRevisionId;
      steering = await this.consumeSteering(runId);
    }
    if (signal?.aborted || settled.some((task) => task.status === 'cancelled')) {
      return { degraded: false, result: { status: 'cancelled', messages: [] } };
    }
    const requiredFailure = settled.find(
      (task) => task.criticality === 'required' && task.status !== 'succeeded',
    );
    if (requiredFailure) {
      return {
        degraded: false,
        result: {
          status: 'failed',
          messages: [],
          error: {
            code: 'runtime_error',
            message: `Required ${requiredFailure.owner} task failed: ${requiredFailure.failure ?? 'dependency failed'}`,
            retryable: false,
          },
        },
      };
    }

    const synthesis = await this.synthesize(runId, activePrompt, settled, signal);
    if (synthesis.status !== 'completed') {
      return { result: synthesis, degraded: false };
    }
    let assistant = findAssistant(synthesis);
    if (!assistant) {
      return {
        degraded: false,
        result: {
          status: 'failed',
          messages: [],
          error: {
            code: 'runtime_error',
            message: 'Main Agent synthesis returned no stable assistant message',
            retryable: true,
          },
        },
      };
    }
    let reviewUsage: RuntimeUsage[] = [];
    let reviewAccepted = true;
    if (this.options.reviewGate?.enabled) {
      const review = await runReviewGate(
        assistant.content,
        async (draft, round) => {
          const editor = await this.reviewDraft(
            runId,
            'editor',
            activePrompt,
            draft,
            round,
            signal,
          );
          const factChecker = await this.reviewDraft(
            runId,
            'fact_checker',
            activePrompt,
            editor.value,
            round,
            signal,
          );
          reviewUsage = [...reviewUsage, ...editor.usage, ...factChecker.usage];
          return {
            accepted: editor.accepted && factChecker.accepted,
            revision: factChecker.value,
          };
        },
        this.options.reviewGate.maxRounds ?? 2,
      );
      reviewAccepted = review.accepted;
      assistant = { ...assistant, content: review.value };
      const event = await this.options.database.transaction((transaction) =>
        appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType: 'review.completed',
          payload: { rounds: review.rounds, accepted: review.accepted },
        }),
      );
      await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
    }
    const aggregateUsage = sumUsage([
      ...settled.flatMap((task) => (task.usage ? [task.usage] : [])),
      assistant.usage,
      ...reviewUsage,
    ]);
    const finalAssistant: RuntimeAssistantMessage = { ...assistant, usage: aggregateUsage };
    return {
      degraded: settled.some((task) => task.status !== 'succeeded') || !reviewAccepted,
      result: { status: 'completed', messages: [finalAssistant] },
    };
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
        outputSchema: { type: 'object', required: ['summary'] },
        toolPolicy: { allow: capabilitiesFor(task.owner) },
        budget: { maxTurns: 20, maxOutputTokens: 4096 },
        status: 'pending' as const,
        maxAttempts: task.criticality === 'required' ? 3 : 1,
      })),
    );
    const dependencies = tasks.flatMap((task) =>
      task.dependencyIds.map((dependencyTaskId) => ({ taskId: task.id, dependencyTaskId })),
    );
    if (dependencies.length > 0) {
      await transaction.insert(agentTaskDependencies).values(dependencies);
    }
    for (const task of tasks) {
      const context = buildContextPack(runId, revisionId, task, prompt);
      await transaction.insert(taskBriefs).values({
        id: this.createId(),
        taskId: task.id,
        objective: task.objective,
        constraints: ['Return a concise result, not hidden reasoning', 'Do not perform writes'],
        expectedOutput: { type: 'summary' },
        contentHash: context.contentHash,
      });
      await transaction.insert(contextPacks).values({
        id: this.createId(),
        taskId: task.id,
        manifest: context.manifest,
        contentHash: context.contentHash,
        tokenCount: estimateTokens(context.prompt),
      });
    }
  }

  private async consumeSteering(
    runId: string,
  ): Promise<{ readonly ids: readonly string[]; readonly content: string } | undefined> {
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
      .orderBy(runDirectives.sequence);
    return directives.length > 0
      ? {
          ids: directives.map(({ id }) => id),
          content: directives.map(({ content }) => content).join('\n'),
        }
      : undefined;
  }

  private async executeDag(
    runId: string,
    revisionId: string,
    tasks: readonly PlannedTaskSpec[],
    rootPrompt: string,
    signal?: AbortSignal,
  ): Promise<readonly SettledTask[]> {
    const settled = new Map<string, SettledTask>();
    const pending = new Map(tasks.map((task) => [task.id, task]));

    while (pending.size > 0) {
      if (signal?.aborted) {
        for (const task of pending.values()) {
          const cancelled = { ...task, status: 'cancelled' as const, failure: 'run_cancelled' };
          settled.set(task.id, cancelled);
          await this.persistCancelledTask(runId, cancelled);
        }
        break;
      }
      const blocked = [...pending.values()].filter((task) =>
        task.dependencyIds.some((id) => {
          const dependency = settled.get(id);
          return dependency && dependency.status !== 'succeeded';
        }),
      );
      for (const task of blocked) {
        pending.delete(task.id);
        const skipped = { ...task, status: 'skipped' as const, failure: 'dependency_failed' };
        settled.set(task.id, skipped);
        await this.persistSkippedTask(runId, skipped);
      }

      const ready = [...pending.values()]
        .filter((task) => task.dependencyIds.every((id) => settled.get(id)?.status === 'succeeded'))
        .slice(0, 4);
      if (ready.length === 0) {
        if (pending.size === 0) {
          break;
        }
        if (blocked.length > 0) {
          continue;
        }
        throw new Error(`Planned Run ${runId} scheduler made no progress`);
      }
      const wave = await Promise.all(
        ready.map((task) => this.executeTask(runId, revisionId, task, rootPrompt, settled, signal)),
      );
      for (const task of wave) {
        pending.delete(task.id);
        settled.set(task.id, task);
      }
    }

    return tasks.map((task) => settled.get(task.id) ?? { ...task, status: 'skipped' });
  }

  private async executeTask(
    runId: string,
    revisionId: string,
    task: PlannedTaskSpec,
    rootPrompt: string,
    settled: ReadonlyMap<string, SettledTask>,
    signal?: AbortSignal,
  ): Promise<SettledTask> {
    const started = await this.options.database.transaction(async (transaction) => {
      await transaction
        .update(agentTasks)
        .set({
          status: 'running',
          attempt: sql`${agentTasks.attempt} + 1`,
          updatedAt: this.now(),
          version: sql`${agentTasks.version} + 1`,
        })
        .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'pending')));
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'task.started',
        payload: { taskId: task.id, owner: task.owner, revisionId },
      });
    });
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(started) });

    const upstream = task.dependencyIds.flatMap((id) => {
      const dependency = settled.get(id);
      return dependency?.output ? [`${dependency.owner}: ${dependency.output}`] : [];
    });
    let result: RuntimeResult;
    try {
      const runtime = this.options.runtimeFactory.create(task.owner);
      result = await runtime.execute(
        {
          runId: `${runId}:${task.id}`,
          systemPrompt: specialistSystemPrompt(task.owner),
          history: [],
          prompt: [
            `Task: ${task.objective}`,
            `Root request: ${rootPrompt}`,
            `Acceptance criteria: ${task.acceptanceCriteria.join('; ')}`,
            ...(upstream.length > 0
              ? [`Upstream accepted artifacts:\n${upstream.join('\n')}`]
              : []),
          ].join('\n\n'),
          ...(this.options.runtimeToolFactory
            ? { tools: await this.options.runtimeToolFactory.createForRun(runId, task.objective) }
            : {}),
        },
        () => undefined,
        signal,
      );
    } catch (error) {
      result = {
        status: 'failed',
        messages: [],
        error: {
          code: 'runtime_error',
          message: error instanceof Error ? error.message : 'Unknown Specialist runtime error',
          retryable: true,
        },
      };
    }
    const assistant = result.status === 'completed' ? findAssistant(result) : undefined;
    const status = assistant
      ? ('succeeded' as const)
      : result.status === 'cancelled'
        ? ('cancelled' as const)
        : ('failed' as const);
    const failure =
      result.status === 'failed'
        ? result.error.message
        : result.status === 'cancelled'
          ? 'run_cancelled'
          : assistant
            ? undefined
            : 'missing_stable_output';
    const taskResult: SettledTask = {
      ...task,
      status,
      ...(assistant ? { output: assistant.content, usage: assistant.usage } : {}),
      ...(failure ? { failure } : {}),
    };
    const completed = await this.options.database.transaction(async (transaction) => {
      const now = this.now();
      await transaction
        .update(agentTasks)
        .set({
          status,
          updatedAt: now,
          completedAt: now,
          version: sql`${agentTasks.version} + 1`,
        })
        .where(eq(agentTasks.id, task.id));
      if (status !== 'cancelled') {
        await transaction.insert(taskResults).values({
          id: this.createId(),
          taskId: task.id,
          attempt: 1,
          status,
          artifacts: assistant ? [{ type: 'text', content: assistant.content }] : [],
          evidence: [],
          usage: assistant ? assistant.usage : {},
          warnings: task.criticality === 'optional' && failure ? [failure] : [],
          ...(failure ? { failure: { message: failure } } : {}),
        });
      }
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'task_settled',
        state: { taskId: task.id, status, attempt: 1 },
      });
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType:
          status === 'succeeded'
            ? 'task.succeeded'
            : status === 'cancelled'
              ? 'task.cancelled'
              : 'task.failed',
        payload: {
          taskId: task.id,
          owner: task.owner,
          criticality: task.criticality,
          ...(failure ? { failure } : {}),
        },
      });
    });
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(completed) });
    return taskResult;
  }

  private async persistSkippedTask(runId: string, task: SettledTask): Promise<void> {
    const event = await this.options.database.transaction(async (transaction) => {
      const now = this.now();
      await transaction
        .update(agentTasks)
        .set({
          status: 'skipped',
          updatedAt: now,
          completedAt: now,
          version: sql`${agentTasks.version} + 1`,
        })
        .where(and(eq(agentTasks.id, task.id), inArray(agentTasks.status, ['pending', 'ready'])));
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'task_settled',
        state: { taskId: task.id, status: 'skipped', reason: task.failure ?? 'dependency_failed' },
      });
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'task.skipped',
        payload: {
          taskId: task.id,
          owner: task.owner,
          reason: task.failure ?? 'dependency_failed',
        },
      });
    });
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
  }

  private async persistCancelledTask(runId: string, task: SettledTask): Promise<void> {
    const event = await this.options.database.transaction(async (transaction) => {
      const now = this.now();
      await transaction
        .update(agentTasks)
        .set({
          status: 'cancelled',
          updatedAt: now,
          completedAt: now,
          version: sql`${agentTasks.version} + 1`,
        })
        .where(and(eq(agentTasks.id, task.id), inArray(agentTasks.status, ['pending', 'ready'])));
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'task_settled',
        state: { taskId: task.id, status: 'cancelled', reason: 'run_cancelled' },
      });
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'task.cancelled',
        payload: { taskId: task.id, owner: task.owner, reason: 'run_cancelled' },
      });
    });
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
  }

  private async synthesize(
    runId: string,
    prompt: string,
    settled: readonly SettledTask[],
    signal?: AbortSignal,
  ): Promise<RuntimeResult> {
    const artifacts = settled
      .filter((task) => task.output)
      .map((task) => `${task.owner}: ${task.output ?? ''}`)
      .join('\n\n');
    try {
      return await this.options.runtimeFactory.create('synthesis').execute(
        {
          runId: `${runId}:synthesis`,
          systemPrompt: this.options.systemPrompt,
          history: [],
          prompt: `Synthesize the final answer for this request:\n${prompt}\n\nAccepted specialist artifacts:\n${artifacts}`,
          ...(this.options.runtimeToolFactory
            ? { tools: await this.options.runtimeToolFactory.createForRun(runId, prompt) }
            : {}),
        },
        async (event) => {
          if (event.type === 'content.delta' || event.type === 'message.started') {
            await this.options.publisher.publish({ durable: false, runId, event });
          }
        },
        signal,
      );
    } catch (error) {
      return {
        status: 'failed',
        messages: [],
        error: {
          code: 'runtime_error',
          message: error instanceof Error ? error.message : 'Unknown synthesis runtime error',
          retryable: true,
        },
      };
    }
  }

  private async reviewDraft(
    runId: string,
    role: 'editor' | 'fact_checker',
    rootPrompt: string,
    draft: string,
    round: number,
    signal?: AbortSignal,
  ): Promise<{
    readonly accepted: boolean;
    readonly value: string;
    readonly usage: RuntimeUsage[];
  }> {
    const result = await this.options.runtimeFactory.create(role).execute(
      {
        runId: `${runId}:review:${role}:${String(round)}`,
        systemPrompt: specialistSystemPrompt(role),
        history: [],
        prompt: [
          'Review the draft against the request and acceptance criteria.',
          'Return strict JSON only: {"accepted":boolean,"revision":string}.',
          'When accepted, revision must equal the original draft.',
          `Request: ${rootPrompt}`,
          `Draft: ${draft}`,
        ].join('\n\n'),
      },
      () => undefined,
      signal,
    );
    const message = result.status === 'completed' ? findAssistant(result) : undefined;
    if (!message) return { accepted: false, value: draft, usage: [] };
    const parsed = parseReview(message.content);
    return {
      accepted: parsed?.accepted ?? false,
      value: parsed?.revision ?? draft,
      usage: [message.usage],
    };
  }

  private async publishAll(events: readonly DurableRunEvent[]): Promise<void> {
    for (const event of events) {
      await this.options.publisher.publish({ durable: true, event });
    }
  }
}

function parseReview(
  value: string,
): { readonly accepted: boolean; readonly revision: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' &&
      parsed !== null &&
      'accepted' in parsed &&
      typeof parsed.accepted === 'boolean' &&
      'revision' in parsed &&
      typeof parsed.revision === 'string'
      ? { accepted: parsed.accepted, revision: parsed.revision }
      : undefined;
  } catch {
    return undefined;
  }
}

export function previewPlan(prompt: string): readonly {
  readonly owner: SpecialistRole;
  readonly criticality: TaskCriticality;
  readonly dependencyCount: number;
}[] {
  return buildPlan(
    prompt,
    (() => {
      let sequence = 0;
      return () => `eval-task-${String(++sequence)}`;
    })(),
  ).map((task) => ({
    owner: task.owner,
    criticality: task.criticality,
    dependencyCount: task.dependencyIds.length,
  }));
}

function buildPlan(prompt: string, createId: () => string): readonly PlannedTaskSpec[] {
  const classification = classifyRun(prompt);
  const wantsResearch =
    classification.reasons.includes('retrieval') || /@researcher|@研究员/i.test(prompt);
  const wantsMedia =
    classification.reasons.includes('media') || /@illustrator|@插画师/i.test(prompt);
  const wantsEditing =
    classification.reasons.includes('article_change') || /@editor|@编辑/i.test(prompt);
  const wantsFactCheck = wantsResearch || /@fact[_ -]?checker|@事实核查/i.test(prompt);
  const tasks: PlannedTaskSpec[] = [];
  const researchId = wantsResearch ? createId() : undefined;
  if (researchId) {
    tasks.push({
      id: researchId,
      owner: 'researcher',
      objective: 'Collect relevant evidence and unresolved questions',
      criticality: 'required',
      acceptanceCriteria: ['Summarize findings', 'Distinguish evidence from uncertainty'],
      dependencyIds: [],
    });
  }
  const writerId = createId();
  tasks.push({
    id: writerId,
    owner: 'writer',
    objective: 'Draft the requested content from the allowed context',
    criticality: 'required',
    acceptanceCriteria: ['Address the root request', 'Return a coherent draft'],
    dependencyIds: researchId ? [researchId] : [],
  });
  if (wantsEditing) {
    tasks.push({
      id: createId(),
      owner: 'editor',
      objective: 'Review the draft for structure, clarity, and style',
      criticality: 'optional',
      acceptanceCriteria: [
        'Identify material issues',
        'Return an improved version or clear advice',
      ],
      dependencyIds: [writerId],
    });
  }
  if (wantsFactCheck) {
    tasks.push({
      id: createId(),
      owner: 'fact_checker',
      objective: 'Check factual claims against the supplied research artifact',
      criticality: 'required',
      acceptanceCriteria: ['Label unsupported claims as uncertain'],
      dependencyIds: researchId ? [researchId, writerId] : [writerId],
    });
  }
  if (wantsMedia) {
    tasks.push({
      id: createId(),
      owner: 'illustrator',
      objective: 'Propose visuals that support the draft',
      criticality: 'optional',
      acceptanceCriteria: ['Return a concrete image plan with placement intent'],
      dependencyIds: [writerId],
    });
  }
  return tasks;
}

function publicTask(task: PlannedTaskSpec): Readonly<Record<string, unknown>> {
  return {
    id: task.id,
    owner: task.owner,
    objective: task.objective,
    criticality: task.criticality,
    acceptanceCriteria: task.acceptanceCriteria,
    dependencyIds: task.dependencyIds,
  };
}

function summarizePlan(tasks: readonly PlannedTaskSpec[]): string {
  return tasks.map((task) => `${task.owner}: ${task.objective}`).join(' -> ');
}

function capabilitiesFor(role: SpecialistRole): readonly string[] {
  switch (role) {
    case 'researcher':
    case 'fact_checker':
      return ['web.research', 'workspace.knowledge.read', 'evidence.read'];
    case 'writer':
    case 'editor':
      return ['article.read', 'evidence.read'];
    case 'illustrator':
      return ['article.read', 'licensed_media.search'];
  }
}

function specialistSystemPrompt(role: SpecialistRole): string {
  return `You are the AgentPress ${role} specialist. Use only the supplied immutable Context Pack. Return the result, not chain-of-thought. Never apply writes or delegate.`;
}

function specialistPromptRevision(role: SpecialistRole) {
  return createPromptRevision(`specialist.${role}`, '1.0.0', specialistSystemPrompt(role));
}

function buildContextPack(
  runId: string,
  revisionId: string,
  task: PlannedTaskSpec,
  prompt: string,
): {
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly prompt: string;
  readonly contentHash: string;
} {
  const promptRevision = specialistPromptRevision(task.owner);
  const manifest = {
    runId,
    planRevisionId: revisionId,
    taskId: task.id,
    owner: task.owner,
    rootRequestIncluded: true,
    conversationHistoryIncluded: false,
    toolAllowlist: capabilitiesFor(task.owner),
    promptRevision: {
      promptId: promptRevision.promptId,
      version: promptRevision.version,
      contentHash: promptRevision.contentHash,
    },
    skillVersions: {},
  };
  const contextPrompt = JSON.stringify({ manifest, objective: task.objective, prompt });
  return {
    manifest,
    prompt: contextPrompt,
    contentHash: createHash('sha256').update(contextPrompt).digest('hex'),
  };
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 3);
}

function findAssistant(result: RuntimeResult): RuntimeAssistantMessage | undefined {
  return result.messages.findLast(
    (message): message is RuntimeAssistantMessage => message.role === 'assistant',
  );
}

function sumUsage(usages: readonly RuntimeUsage[]): RuntimeUsage {
  return usages.reduce<RuntimeUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
      costUsd: total.costUsd + usage.costUsd,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  );
}

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

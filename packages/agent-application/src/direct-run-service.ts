import { randomUUID } from 'node:crypto';

import type {
  RuntimeAssistantMessage,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeResult,
} from '@agentpress/agent-runtime';
import {
  agentRuns,
  agentTasks,
  appendCheckpoint,
  appendRunEvent,
  type AgentPressDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  enqueueOutboxMessage,
  rootRequests,
  runDirectives,
  runEvents,
  toolCalls,
  workspaceMembers,
} from '@agentpress/database';
import { and, asc, eq, gt, inArray, lt, max, sql } from 'drizzle-orm';

import {
  AGENT_RUN_COMMAND_TOPIC,
  AgentApplicationError,
  type AgentRuntimeFactory,
  type CreateDirectRunInput,
  type CreateDirectRunResult,
  type DurableRunEvent,
  type ExecuteDirectRunResult,
  type EnqueueRunDirectiveResult,
  type RequestRunCancellationResult,
  type RunEventPublisher,
  type RuntimeToolFactory,
} from './contracts.js';
import { PlannedRunExecutor } from './planned-run-executor.js';
import { classifyRun } from './run-classifier.js';
import { RunContextService } from './run-context-service.js';

const TERMINAL_RUN_STATES = [
  'cancelled',
  'completed',
  'completed_with_degradation',
  'failed',
] as const;

type DirectRunServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly runtimeFactory: AgentRuntimeFactory;
  readonly publisher: RunEventPublisher;
  readonly systemPrompt: string;
  readonly runtimeToolFactory?: RuntimeToolFactory;
  readonly reviewGate?: { readonly enabled: boolean; readonly maxRounds?: number };
  readonly now?: () => Date;
  readonly createId?: () => string;
};

export class DirectRunService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly plannedRuns: PlannedRunExecutor;
  private readonly contexts: RunContextService;

  public constructor(private readonly options: DirectRunServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.plannedRuns = new PlannedRunExecutor(options);
    this.contexts = new RunContextService(
      options.database,
      options.systemPrompt,
      128_000,
      this.createId,
    );
  }

  public async create(input: CreateDirectRunInput): Promise<CreateDirectRunResult> {
    const prompt = input.prompt.trim();
    if (prompt.length === 0 || prompt.length > 100_000) {
      throw new AgentApplicationError(
        'invalid_prompt',
        'Prompt must contain between 1 and 100000 characters',
      );
    }

    const result = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${input.branchId}:${input.idempotencyKey}`}))`,
      );

      const existing = await transaction
        .select({
          runId: agentRuns.id,
          rootRequestId: rootRequests.id,
          messageId: rootRequests.messageId,
          status: agentRuns.status,
          mode: agentRuns.mode,
        })
        .from(rootRequests)
        .innerJoin(agentRuns, eq(agentRuns.rootRequestId, rootRequests.id))
        .where(
          and(
            eq(rootRequests.branchId, input.branchId),
            eq(rootRequests.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      const duplicate = existing[0];
      if (duplicate) {
        return {
          result: {
            runId: duplicate.runId,
            rootRequestId: duplicate.rootRequestId,
            messageId: duplicate.messageId,
            status: duplicate.status,
            mode: duplicate.mode,
            created: false,
          },
        };
      }

      const branchRows = await transaction
        .select({
          branchId: conversationBranches.id,
          conversationId: conversations.id,
          workspaceId: conversations.workspaceId,
        })
        .from(conversationBranches)
        .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
        .where(eq(conversationBranches.id, input.branchId))
        .limit(1);
      const branch = branchRows[0];
      if (!branch) {
        throw new AgentApplicationError('branch_not_found', 'Conversation branch does not exist');
      }
      if (branch.conversationId !== input.conversationId) {
        throw new AgentApplicationError(
          'conversation_not_found',
          'Conversation does not own the requested branch',
        );
      }
      const membership = await transaction
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, branch.workspaceId),
            eq(workspaceMembers.userId, input.userId),
          ),
        )
        .limit(1);
      if (!membership[0]) {
        throw new AgentApplicationError(
          'unauthorized_user',
          'User is not a member of the conversation workspace',
        );
      }

      await transaction.execute(
        sql`select id from ${conversationBranches} where id = ${input.branchId} for update`,
      );
      const sequenceRows = await transaction
        .select({ sequence: max(conversationMessages.sequence) })
        .from(conversationMessages)
        .where(eq(conversationMessages.branchId, input.branchId));
      const messageSequence = (sequenceRows[0]?.sequence ?? 0) + 1;
      const messageId = this.createId();
      const rootRequestId = this.createId();
      const runId = this.createId();
      const outboxId = this.createId();
      const now = this.now();
      const classification = classifyRun(prompt);
      const userMessage: RuntimeMessage = {
        role: 'user',
        content: prompt,
        timestamp: now.getTime(),
      };

      await transaction.insert(conversationMessages).values({
        id: messageId,
        branchId: input.branchId,
        role: 'user',
        sequence: messageSequence,
        content: encodeRuntimeMessage(userMessage),
        stable: true,
        createdAt: now,
      });
      await transaction.insert(rootRequests).values({
        id: rootRequestId,
        branchId: input.branchId,
        messageId,
        requestedByUserId: input.userId,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
      });
      await transaction.insert(agentRuns).values({
        id: runId,
        workspaceId: branch.workspaceId,
        branchId: input.branchId,
        rootRequestId,
        mode: classification.mode,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      });
      const contextPack = await this.contexts.prepare(transaction, {
        runId,
        workspaceId: branch.workspaceId,
        userId: input.userId,
        mentionTargetIds: input.mentionTargetIds ?? [],
        skills: input.skills ?? [],
      });
      const queued = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.queued',
        payload: {
          mode: classification.mode,
          reasons: classification.reasons,
          rootRequestId,
          contextManifest: contextPack.manifest,
          contextHash: contextPack.contentHash,
        },
      });
      await enqueueOutboxMessage(transaction, {
        id: outboxId,
        aggregateType: 'AgentRun',
        aggregateId: runId,
        topic: AGENT_RUN_COMMAND_TOPIC,
        messageKey: runId,
        payload: { command: 'run.execute', messageId: outboxId, runId },
        occurredAt: now,
      });

      return {
        result: {
          runId,
          rootRequestId,
          messageId,
          status: 'queued' as const,
          mode: classification.mode,
          created: true,
        },
        event: toDurableEvent(queued),
      };
    });

    if (result.event) {
      await this.options.publisher.publish({ durable: true, event: result.event });
    }
    return result.result;
  }

  public async execute(runId: string, signal?: AbortSignal): Promise<ExecuteDirectRunResult> {
    const context = await this.loadExecutionContext(runId);
    if (!context) {
      throw new AgentApplicationError('run_not_found', `Agent Run ${runId} does not exist`);
    }
    if (context.status === 'cancelling') {
      return this.settleRun(context.branchId, runId, {
        status: 'cancelled',
        messages: context.history,
      });
    }
    if (context.status !== 'queued' && context.status !== 'recovering') {
      return { runId, status: 'ignored' };
    }
    const effectivePrompt = withContext(context.prompt, context.contextContent);
    if (context.mode === 'planned') {
      const outcome =
        context.status === 'recovering'
          ? await this.plannedRuns.recover(runId, effectivePrompt, signal)
          : await this.plannedRuns.execute(runId, effectivePrompt, signal);
      if (!outcome) {
        return { runId, status: 'ignored' };
      }
      return this.settleRun(context.branchId, runId, outcome.result, outcome.degraded);
    }

    const recovering = context.status === 'recovering';
    const started = await this.options.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(agentRuns)
        .set({ status: 'running', updatedAt: this.now(), version: sql`${agentRuns.version} + 1` })
        .where(
          and(eq(agentRuns.id, runId), eq(agentRuns.status, recovering ? 'recovering' : 'queued')),
        )
        .returning({ id: agentRuns.id });
      if (updated.length === 0) {
        return undefined;
      }
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: recovering ? 'run.recovered' : 'run.started',
        payload: { mode: 'direct', ...(recovering ? { fromCheckpoint: true } : {}) },
      });
    });
    if (!started) {
      return { runId, status: 'ignored' };
    }
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(started) });

    let result: RuntimeResult;
    try {
      const runtime = this.options.runtimeFactory.create('direct');
      result = await runtime.execute(
        {
          runId,
          systemPrompt: this.options.systemPrompt,
          history: context.history,
          prompt: effectivePrompt,
          ...(this.options.runtimeToolFactory
            ? { tools: await this.options.runtimeToolFactory.createForRun(runId, effectivePrompt) }
            : {}),
        },
        (event) => this.publishRuntimeEvent(runId, event),
        signal,
      );
    } catch (error) {
      result = {
        status: 'failed',
        messages: context.history,
        error: {
          code: 'runtime_error',
          message: error instanceof Error ? error.message : 'Unknown runtime boundary error',
          retryable: true,
        },
      };
    }

    return this.settleRun(context.branchId, runId, result);
  }

  public async requestCancellation(runId: string): Promise<RequestRunCancellationResult> {
    const settled = await this.options.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const current = rows[0];
      if (!current) {
        return { outcome: 'not_found' as const, runId };
      }
      if (TERMINAL_RUN_STATES.includes(current.status as (typeof TERMINAL_RUN_STATES)[number])) {
        return { outcome: 'already_terminal' as const, runId, status: current.status };
      }
      if (current.status === 'cancelling') {
        return { outcome: 'accepted' as const, runId, status: 'cancelling' as const };
      }

      const updated = await transaction
        .update(agentRuns)
        .set({
          status: 'cancelling',
          updatedAt: this.now(),
          version: sql`${agentRuns.version} + 1`,
        })
        .where(
          and(
            eq(agentRuns.id, runId),
            inArray(agentRuns.status, [
              'queued',
              'planning',
              'running',
              'waiting_for_approval',
              'waiting_for_user',
              'interrupted',
              'recovering',
            ]),
          ),
        )
        .returning({ id: agentRuns.id });
      if (updated.length === 0) {
        return { outcome: 'already_terminal' as const, runId, status: current.status };
      }
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.cancelling',
        payload: {},
      });
      return {
        outcome: 'accepted' as const,
        runId,
        status: 'cancelling' as const,
        event: toDurableEvent(event),
      };
    });

    if ('event' in settled) {
      await this.options.publisher.publish({ durable: true, event: settled.event });
    }
    return settled;
  }

  public async prepareRecovery(runId: string): Promise<boolean> {
    const result = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from ${agentRuns} where id = ${runId} for update`);
      const rows = await transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const run = rows[0];
      if (!run || run.status === 'queued' || run.status === 'recovering') {
        return { recovered: run?.status === 'recovering', events: [] as DurableRunEvent[] };
      }
      if (!isRecoverableRunStatus(run.status)) {
        return { recovered: false, events: [] as DurableRunEvent[] };
      }
      const now = this.now();
      const executing = await transaction
        .select({ id: toolCalls.id, risk: toolCalls.risk })
        .from(toolCalls)
        .where(and(eq(toolCalls.runId, runId), eq(toolCalls.status, 'executing')));
      const events: DurableRunEvent[] = [];
      for (const call of executing) {
        const status =
          call.risk === 'external_write' || call.risk === 'destructive'
            ? ('outcome_unknown' as const)
            : ('failed' as const);
        await transaction
          .update(toolCalls)
          .set({
            status,
            failure: { message: 'Worker lease was lost during tool execution' },
            settledAt: now,
            updatedAt: now,
            version: sql`${toolCalls.version} + 1`,
          })
          .where(and(eq(toolCalls.id, call.id), eq(toolCalls.status, 'executing')));
        const toolEvent = await appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType: `tool.${status}`,
          payload: { toolCallId: call.id, reason: 'worker_lease_lost' },
        });
        events.push(toDurableEvent(toolEvent));
      }
      await transaction
        .update(agentTasks)
        .set({ status: 'interrupted', updatedAt: now, version: sql`${agentTasks.version} + 1` })
        .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, 'running')));
      await transaction
        .update(agentRuns)
        .set({ status: 'recovering', updatedAt: now, version: sql`${agentRuns.version} + 1` })
        .where(
          and(
            eq(agentRuns.id, runId),
            inArray(agentRuns.status, ['planning', 'running', 'interrupted']),
          ),
        );
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'worker_recovery',
        state: { previousStatus: run.status, interruptedToolCalls: executing.map(({ id }) => id) },
      });
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.recovering',
        payload: { previousStatus: run.status },
      });
      events.push(toDurableEvent(event));
      return { recovered: true, events };
    });
    for (const event of result.events) {
      await this.options.publisher.publish({ durable: true, event });
    }
    return result.recovered;
  }

  public enqueueSteering(runId: string, content: string): Promise<EnqueueRunDirectiveResult> {
    return this.enqueueDirective(runId, 'steering', content);
  }

  public enqueueFollowUp(runId: string, content: string): Promise<EnqueueRunDirectiveResult> {
    return this.enqueueDirective(runId, 'follow_up', content);
  }

  public async listEvents(runId: string, afterSequence = 0): Promise<readonly DurableRunEvent[]> {
    const events = await this.options.database
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.sequence, afterSequence)))
      .orderBy(asc(runEvents.sequence));
    return events.map(toDurableEvent);
  }

  private async loadExecutionContext(runId: string): Promise<
    | {
        readonly branchId: string;
        readonly prompt: string;
        readonly history: readonly RuntimeMessage[];
        readonly status: string;
        readonly mode: 'direct' | 'planned';
        readonly contextContent: string;
      }
    | undefined
  > {
    const runRows = await this.options.database
      .select({
        branchId: agentRuns.branchId,
        status: agentRuns.status,
        mode: agentRuns.mode,
        messageSequence: conversationMessages.sequence,
        content: conversationMessages.content,
      })
      .from(agentRuns)
      .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
      .innerJoin(conversationMessages, eq(conversationMessages.id, rootRequests.messageId))
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const run = runRows[0];
    if (!run) {
      return undefined;
    }
    const rootMessage = decodeRuntimeMessage(run.content);
    if (rootMessage?.role !== 'user') {
      throw new Error(`Root message for Agent Run ${runId} is invalid`);
    }

    const historyRows = await this.options.database
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.branchId, run.branchId),
          eq(conversationMessages.stable, true),
          lt(conversationMessages.sequence, run.messageSequence),
        ),
      )
      .orderBy(asc(conversationMessages.sequence));
    const history = historyRows.flatMap(({ content }) => {
      const message = decodeRuntimeMessage(content);
      return message ? [message] : [];
    });
    const contextPack = await this.contexts.load(runId);
    if (!contextPack) throw new Error(`Agent Run ${runId} has no persisted Context Pack`);

    return {
      branchId: run.branchId,
      prompt: rootMessage.content,
      history,
      status: run.status,
      mode: run.mode,
      contextContent: contextPack.content,
    };
  }

  private async publishRuntimeEvent(runId: string, event: RuntimeEvent): Promise<void> {
    if (
      event.type === 'content.delta' ||
      event.type === 'message.started' ||
      event.type === 'turn.started'
    ) {
      await this.options.publisher.publish({ durable: false, runId, event });
    }
  }

  private async enqueueDirective(
    runId: string,
    kind: 'steering' | 'follow_up',
    rawContent: string,
  ): Promise<EnqueueRunDirectiveResult> {
    const content = rawContent.trim();
    if (content.length === 0 || content.length > 100_000) {
      throw new AgentApplicationError(
        'invalid_directive',
        'Directive must contain between 1 and 100000 characters',
      );
    }
    const persisted = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from ${agentRuns} where id = ${runId} for update`);
      const rows = await transaction
        .select({ mode: agentRuns.mode, status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const run = rows[0];
      if (!run) {
        throw new AgentApplicationError('run_not_found', `Agent Run ${runId} does not exist`);
      }
      if (TERMINAL_RUN_STATES.includes(run.status as (typeof TERMINAL_RUN_STATES)[number])) {
        throw new AgentApplicationError('invalid_directive', 'A terminal Run cannot accept input');
      }
      if (kind === 'steering' && run.mode !== 'planned') {
        throw new AgentApplicationError(
          'invalid_directive',
          'Steering is available after a Run has entered Planned mode',
        );
      }
      const sequences = await transaction
        .select({ sequence: max(runDirectives.sequence) })
        .from(runDirectives)
        .where(eq(runDirectives.runId, runId));
      const sequence = (sequences[0]?.sequence ?? 0) + 1;
      const directiveId = this.createId();
      await transaction.insert(runDirectives).values({
        id: directiveId,
        runId,
        sequence,
        kind,
        content,
      });
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: `${kind}.queued`,
        payload: { directiveId, sequence },
      });
      return {
        result: { directiveId, runId, kind, sequence, status: 'pending' as const },
        event: toDurableEvent(event),
      };
    });
    await this.options.publisher.publish({ durable: true, event: persisted.event });
    return persisted.result;
  }

  private async settleRun(
    branchId: string,
    runId: string,
    result: RuntimeResult,
    completedWithDegradation = false,
  ): Promise<ExecuteDirectRunResult> {
    const durableEvents = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${conversationBranches} where id = ${branchId} for update`,
      );
      const statusRows = await transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const currentStatus = statusRows[0]?.status;
      const now = this.now();
      const events: DurableRunEvent[] = [];

      if (result.status === 'completed' && currentStatus !== 'cancelling') {
        const assistant = findLastAssistantMessage(result.messages);
        if (!assistant) {
          throw new Error(`Pi completed Agent Run ${runId} without a stable assistant message`);
        }
        const sequenceRows = await transaction
          .select({ sequence: max(conversationMessages.sequence) })
          .from(conversationMessages)
          .where(eq(conversationMessages.branchId, branchId));
        await transaction.insert(conversationMessages).values({
          id: this.createId(),
          branchId,
          runId,
          role: 'assistant',
          sequence: (sequenceRows[0]?.sequence ?? 0) + 1,
          content: encodeRuntimeMessage(assistant),
          stable: true,
          createdAt: now,
        });
        await transaction
          .update(agentRuns)
          .set({
            status: completedWithDegradation ? 'completed_with_degradation' : 'completed',
            finalOutcome: { usage: assistant.usage },
            completedAt: now,
            updatedAt: now,
            version: sql`${agentRuns.version} + 1`,
          })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')));
        await appendCheckpoint(transaction, {
          id: this.createId(),
          runId,
          reason: 'run_settled',
          state: {
            status: completedWithDegradation ? 'completed_with_degradation' : 'completed',
            stableAssistantMessage: assistant,
          },
        });
        const messageEvent = await appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType: 'message.completed',
          payload: { message: assistant },
        });
        events.push(toDurableEvent(messageEvent));
        const completedEvent = await appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType: completedWithDegradation ? 'run.completed_with_degradation' : 'run.completed',
          payload: { usage: assistant.usage, degraded: completedWithDegradation },
        });
        events.push(toDurableEvent(completedEvent));
        return events;
      }

      if (result.status === 'cancelled' || currentStatus === 'cancelling') {
        await transaction
          .update(agentRuns)
          .set({
            status: 'cancelled',
            completedAt: now,
            updatedAt: now,
            version: sql`${agentRuns.version} + 1`,
          })
          .where(
            and(eq(agentRuns.id, runId), inArray(agentRuns.status, ['running', 'cancelling'])),
          );
        await appendCheckpoint(transaction, {
          id: this.createId(),
          runId,
          reason: 'run_settled',
          state: { status: 'cancelled' },
        });
        const event = await appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType: 'run.cancelled',
          payload: {},
        });
        events.push(toDurableEvent(event));
        return events;
      }

      if (result.status !== 'failed') {
        throw new Error(`Agent Run ${runId} reached an invalid settlement branch`);
      }

      await transaction
        .update(agentRuns)
        .set({
          status: 'failed',
          finalOutcome: { error: result.error },
          completedAt: now,
          updatedAt: now,
          version: sql`${agentRuns.version} + 1`,
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')));
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'run_settled',
        state: { status: 'failed', error: result.error },
      });
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.failed',
        payload: { error: result.error },
      });
      events.push(toDurableEvent(event));
      return events;
    });

    for (const event of durableEvents) {
      await this.options.publisher.publish({ durable: true, event });
    }
    const terminal = durableEvents.at(-1)?.eventType;
    const response: ExecuteDirectRunResult = {
      runId,
      status:
        terminal === 'run.completed' || terminal === 'run.completed_with_degradation'
          ? terminal === 'run.completed_with_degradation'
            ? 'completed_with_degradation'
            : 'completed'
          : terminal === 'run.cancelled'
            ? 'cancelled'
            : 'failed',
    };
    await this.activateNextFollowUp(branchId);
    return response;
  }

  private async activateNextFollowUp(branchId: string): Promise<void> {
    const claimed = await this.options.database.transaction(async (transaction) => {
      const directives = await transaction
        .select({
          id: runDirectives.id,
          content: runDirectives.content,
          branchId: agentRuns.branchId,
          conversationId: conversations.id,
          requestedByUserId: sql<string | null>`${rootRequests.requestedByUserId}`,
        })
        .from(runDirectives)
        .innerJoin(agentRuns, eq(agentRuns.id, runDirectives.runId))
        .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
        .innerJoin(conversationBranches, eq(conversationBranches.id, agentRuns.branchId))
        .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
        .where(
          and(
            eq(agentRuns.branchId, branchId),
            eq(runDirectives.kind, 'follow_up'),
            eq(runDirectives.status, 'pending'),
          ),
        )
        .orderBy(asc(agentRuns.createdAt), asc(runDirectives.sequence))
        .limit(1);
      const directive = directives[0];
      if (!directive) {
        return undefined;
      }
      const updated = await transaction
        .update(runDirectives)
        .set({ status: 'applied', appliedAt: this.now() })
        .where(and(eq(runDirectives.id, directive.id), eq(runDirectives.status, 'pending')))
        .returning({ id: runDirectives.id });
      return updated.length === 1 ? directive : undefined;
    });
    if (!claimed) {
      return;
    }
    if (!claimed.requestedByUserId) {
      throw new AgentApplicationError(
        'unauthorized_user',
        'Follow-up Run does not have a bound requesting user',
      );
    }
    try {
      await this.create({
        conversationId: claimed.conversationId,
        branchId: claimed.branchId,
        userId: claimed.requestedByUserId,
        prompt: claimed.content,
        idempotencyKey: `follow-up:${claimed.id}`,
      });
      await this.options.database
        .update(runDirectives)
        .set({ status: 'consumed', appliedAt: this.now() })
        .where(eq(runDirectives.id, claimed.id));
    } catch (error) {
      await this.options.database
        .update(runDirectives)
        .set({ status: 'pending', appliedAt: null })
        .where(eq(runDirectives.id, claimed.id));
      throw error;
    }
  }
}

function encodeRuntimeMessage(message: RuntimeMessage): readonly unknown[] {
  return [{ type: 'agentpress.runtime-message', version: 1, message }];
}

function isRecoverableRunStatus(status: string): status is 'planning' | 'running' | 'interrupted' {
  return status === 'planning' || status === 'running' || status === 'interrupted';
}

function decodeRuntimeMessage(content: readonly unknown[]): RuntimeMessage | undefined {
  const envelope = content[0];
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !('type' in envelope) ||
    envelope.type !== 'agentpress.runtime-message' ||
    !('message' in envelope)
  ) {
    return undefined;
  }
  const message = envelope.message;
  if (
    typeof message !== 'object' ||
    message === null ||
    !('role' in message) ||
    (message.role !== 'user' && message.role !== 'assistant') ||
    !('content' in message) ||
    typeof message.content !== 'string' ||
    !('timestamp' in message) ||
    typeof message.timestamp !== 'number'
  ) {
    return undefined;
  }
  return message as RuntimeMessage;
}

function findLastAssistantMessage(
  messages: readonly RuntimeMessage[],
): RuntimeAssistantMessage | undefined {
  return messages.findLast(
    (message): message is RuntimeAssistantMessage => message.role === 'assistant',
  );
}

function withContext(prompt: string, context: string): string {
  return context.length > 0
    ? `${context}\n<root-request-json>${JSON.stringify(prompt)}</root-request-json>`
    : prompt;
}

function toDurableEvent(event: typeof runEvents.$inferSelect): DurableRunEvent {
  return {
    id: event.id,
    runId: event.runId,
    sequence: event.sequence,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

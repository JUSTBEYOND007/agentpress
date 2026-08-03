import { randomUUID } from 'node:crypto';

import type {
  RuntimeAssistantMessage,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeResult,
} from '@agentpress/agent-runtime';
import { RUNTIME_CURRENT_TURN_VERSION } from '@agentpress/agent-runtime';
import { parseActionEnvelope, type ActionEnvelopeV1 } from '@agentpress/contracts';
import {
  agentRuns,
  agentTasks,
  approvals,
  artifacts,
  artifactVersions,
  appendCheckpoint,
  appendRunEvent,
  type AgentPressDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  checkpoints,
  enqueueOutboxMessage,
  evidenceRecords,
  editProposals,
  modelSelections,
  rootRequests,
  planRevisions,
  queuedFollowups,
  runQuestions,
  runDirectives,
  runEvents,
  toolCalls,
  workspaceMembers,
} from '@agentpress/database';
import { and, asc, desc, eq, gt, inArray, lt, lte, max, sql } from 'drizzle-orm';

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
  type RunProjection,
  type RunEventPublisher,
  type RuntimeToolFactory,
} from './contracts.js';
import { classifyTerminalOutcome } from './terminal-outcome-policy.js';
import { PlannedRunExecutor } from './planned-run-executor.js';
import { projectConversationHistory } from './agent-transcript-projector.js';
import { RunContextService } from './run-context-service.js';
import { projectRunParts, type ProposalProjectionStatus } from './run-projection.js';
import { projectRunExecutionFacts } from './run-execution-facts.js';
import { projectRunProgress } from './run-progress.js';
import { ArtifactQueryService, type ArtifactLookupResult } from './artifact-query-service.js';

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
  readonly now?: () => Date;
  readonly createId?: () => string;
  /** Disable outbox dispatch only for isolated evaluation harnesses. Production defaults to true. */
  readonly dispatchCommands?: boolean;
};

export class DirectRunService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly plannedRuns: PlannedRunExecutor;
  private readonly contexts: RunContextService;
  private readonly artifactQueries: ArtifactQueryService;

  public constructor(private readonly options: DirectRunServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.plannedRuns = new PlannedRunExecutor(options);
    this.artifactQueries = new ArtifactQueryService(options.database);
    this.contexts = new RunContextService(
      options.database,
      options.systemPrompt,
      128_000,
      this.createId,
    );
  }

  public async listMessages(
    conversationId: string,
    branchId: string,
    userId: string,
  ): Promise<readonly { id: string; role: 'user' | 'assistant'; content: string }[]> {
    const rows = await this.options.database
      .select({
        id: conversationMessages.id,
        role: conversationMessages.role,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .innerJoin(conversationBranches, eq(conversationBranches.id, conversationMessages.branchId))
      .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, conversations.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversationBranches.id, branchId),
          eq(conversationMessages.stable, true),
          inArray(conversationMessages.role, ['user', 'assistant']),
        ),
      )
      .orderBy(asc(conversationMessages.sequence));
    return rows.flatMap((row) => {
      const message = decodeRuntimeMessage(row.content);
      return message ? [{ id: row.id, role: message.role, content: message.content }] : [];
    });
  }

  public async forkBranch(
    conversationId: string,
    branchId: string,
    messageId: string,
    userId: string,
  ) {
    return this.options.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          workspaceId: conversations.workspaceId,
          sequence: conversationMessages.sequence,
        })
        .from(conversationMessages)
        .innerJoin(conversationBranches, eq(conversationBranches.id, conversationMessages.branchId))
        .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, conversations.workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        )
        .where(
          and(
            eq(conversationMessages.id, messageId),
            eq(conversationMessages.branchId, branchId),
            eq(conversations.id, conversationId),
            eq(conversationMessages.stable, true),
          ),
        )
        .limit(1);
      const forkPoint = rows[0];
      if (!forkPoint)
        throw new AgentApplicationError(
          'branch_not_found',
          'Fork message does not exist on an authorized conversation branch',
        );
      const messages = await transaction
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.branchId, branchId),
            eq(conversationMessages.stable, true),
            lte(conversationMessages.sequence, forkPoint.sequence),
          ),
        )
        .orderBy(asc(conversationMessages.sequence));
      const newBranchId = this.createId();
      const copied = messages.map((message) => ({
        sourceId: message.id,
        id: this.createId(),
        message,
      }));
      await transaction.insert(conversationBranches).values({
        id: newBranchId,
        conversationId,
        parentBranchId: branchId,
        forkedFromMessageId: messageId,
      });
      if (copied.length > 0)
        await transaction.insert(conversationMessages).values(
          copied.map(({ id, message }) => ({
            id,
            branchId: newBranchId,
            role: message.role,
            sequence: message.sequence,
            content: message.content,
            stable: true,
            createdAt: message.createdAt,
          })),
        );
      return {
        branchId: newBranchId,
        parentBranchId: branchId,
        forkedFromMessageId: messageId,
        forkedMessageId: copied.find(({ sourceId }) => sourceId === messageId)?.id,
      };
    });
  }

  public async create(input: CreateDirectRunInput): Promise<CreateDirectRunResult> {
    return this.createWithEnvelope(input, {
      version: 1,
      source: 'free_text',
      grantedCapabilities: [],
    });
  }

  public async createConfirmedAction(input: {
    readonly conversationId: string;
    readonly branchId: string;
    readonly userId: string;
    readonly proposalId: string;
    readonly instruction: string;
    readonly articleId: string;
    readonly baseRevisionId: string;
    readonly selectedBlocks: readonly { readonly blockId: string; readonly contentHash: string }[];
    readonly grantedCapabilities: readonly string[];
  }): Promise<CreateDirectRunResult> {
    const envelope: ActionEnvelopeV1 = {
      version: 1,
      source: 'button',
      requestedIntent: 'article_edit',
      actionProposalId: input.proposalId,
      payload: {
        instruction: input.instruction,
        articleId: input.articleId,
        baseRevisionId: input.baseRevisionId,
        selectedBlocks: [...input.selectedBlocks],
      },
      grantedCapabilities: [...input.grantedCapabilities],
    };
    return this.createWithEnvelope(
      {
        conversationId: input.conversationId,
        branchId: input.branchId,
        userId: input.userId,
        prompt: input.instruction,
        idempotencyKey: `action:${input.proposalId}`,
        contextBindings:
          input.selectedBlocks.length > 0
            ? [
                {
                  type: 'article_selection',
                  articleId: input.articleId,
                  revisionId: input.baseRevisionId,
                  blocks: input.selectedBlocks,
                },
              ]
            : [
                {
                  type: 'article_revision',
                  articleId: input.articleId,
                  revisionId: input.baseRevisionId,
                },
              ],
      },
      envelope,
    );
  }

  private async createWithEnvelope(
    input: CreateDirectRunInput,
    actionEnvelope: ActionEnvelopeV1,
  ): Promise<CreateDirectRunResult> {
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
          articleId: conversations.articleId,
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
      const existingMessage = input.existingMessageId
        ? await transaction
            .select({ id: conversationMessages.id, content: conversationMessages.content })
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.id, input.existingMessageId),
                eq(conversationMessages.branchId, input.branchId),
                eq(conversationMessages.role, 'user'),
                eq(conversationMessages.stable, true),
              ),
            )
            .limit(1)
        : [];
      const existingRoot = existingMessage[0];
      if (input.existingMessageId) {
        const decoded = existingRoot ? decodeRuntimeMessage(existingRoot.content) : undefined;
        if (decoded?.role !== 'user' || decoded.content !== prompt) {
          throw new AgentApplicationError(
            'invalid_context',
            'The existing root message is missing or does not match this Run',
          );
        }
      }
      const messageId = existingRoot?.id ?? this.createId();
      const rootRequestId = this.createId();
      const runId = this.createId();
      const outboxId = this.createId();
      const now = this.now();
      const userMessage: RuntimeMessage = {
        role: 'user',
        content: prompt,
        timestamp: now.getTime(),
      };

      if (!existingRoot)
        await transaction.insert(conversationMessages).values({
          id: messageId,
          branchId: input.branchId,
          role: 'user',
          sequence: messageSequence,
          content: encodeRuntimeMessage(userMessage),
          stable: true,
          createdAt: now,
        });
      if (actionEnvelope.source === 'free_text') {
        await transaction
          .update(conversations)
          .set({ title: prompt.slice(0, 24), updatedAt: now })
          .where(
            and(eq(conversations.id, branch.conversationId), eq(conversations.title, '新对话')),
          );
      }
      await transaction.insert(rootRequests).values({
        id: rootRequestId,
        branchId: input.branchId,
        messageId,
        requestedByUserId: input.userId,
        idempotencyKey: input.idempotencyKey,
        actionEnvelope,
        createdAt: now,
      });
      await transaction.insert(agentRuns).values({
        id: runId,
        workspaceId: branch.workspaceId,
        branchId: input.branchId,
        rootRequestId,
        mode: 'direct',
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      });
      const contextPack = await this.contexts.prepare(transaction, {
        runId,
        workspaceId: branch.workspaceId,
        userId: input.userId,
        mentionTargetIds: input.mentionTargetIds ?? [],
        attachmentIds: input.attachmentIds ?? [],
        skills: input.skills ?? [],
        contextBindings: [
          ...(actionEnvelope.source === 'free_text' && branch.articleId
            ? ([{ type: 'mention', targetId: branch.articleId }] as const)
            : []),
          ...(input.contextBindings ?? []),
        ],
      });
      const queued = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.queued',
        payload: {
          mode: 'direct' as const,
          rootRequestId,
          contextManifest: contextPack.manifest,
          contextHash: contextPack.contentHash,
        },
      });
      if (this.options.dispatchCommands !== false) {
        await enqueueOutboxMessage(transaction, {
          id: outboxId,
          aggregateType: 'AgentRun',
          aggregateId: runId,
          topic: AGENT_RUN_COMMAND_TOPIC,
          messageKey: runId,
          payload: { command: 'run.execute', messageId: outboxId, runId },
          occurredAt: now,
        });
      }

      return {
        result: {
          runId,
          rootRequestId,
          messageId,
          status: 'queued' as const,
          mode: 'direct' as const,
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
    try {
      return await this.executeClaimed(runId, signal);
    } catch (error) {
      return this.settleUnexpectedFailure(runId, error, signal);
    }
  }

  private async executeClaimed(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ExecuteDirectRunResult> {
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
    const currentTurn = {
      type: 'agentpress_current_turn' as const,
      version: RUNTIME_CURRENT_TURN_VERSION,
      source: 'user' as const,
      request: context.prompt,
      actionEnvelope: context.actionEnvelope,
      context: context.contextPack,
      timestamp: context.timestamp,
    };
    const outcome =
      context.status === 'recovering'
        ? await this.plannedRuns.recover(runId, currentTurn, context.history, signal)
        : await this.plannedRuns.execute(runId, currentTurn, context.history, signal);
    if (!outcome) return { runId, status: 'ignored' };
    if (signal?.aborted && outcome.result.status === 'failed') {
      throw new Error(outcome.result.error.message);
    }
    return this.settleRun(context.branchId, runId, outcome.result, outcome.degraded);
  }

  private async settleUnexpectedFailure(
    runId: string,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<ExecuteDirectRunResult> {
    const rows = await this.options.database
      .select({ branchId: agentRuns.branchId, status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const run = rows[0];
    if (!run) {
      throw error;
    }
    if (isTerminalRunStatus(run.status)) {
      return { runId, status: 'ignored' };
    }
    if (signal?.aborted && run.status !== 'cancelling') {
      throw error;
    }
    return this.settleRun(run.branchId, runId, {
      status: 'failed',
      messages: [],
      error: {
        code: 'runtime_error',
        message: error instanceof Error ? error.message : 'Agent Run execution failed',
        retryable: false,
      },
    });
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

  public async steerActiveMain(
    runId: string,
    directiveId: string,
    content: string,
  ): Promise<boolean> {
    if (!this.plannedRuns.steerActiveMain(runId, content)) return false;
    const event = await this.options.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(runDirectives)
        .set({ status: 'applied', appliedAt: this.now() })
        .where(
          and(
            eq(runDirectives.id, directiveId),
            eq(runDirectives.runId, runId),
            eq(runDirectives.kind, 'steering'),
            eq(runDirectives.status, 'pending'),
          ),
        )
        .returning({ id: runDirectives.id });
      if (updated.length === 0) return undefined;
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId,
        reason: 'steering_applied',
        state: { directiveId, delivery: 'active_main' },
      });
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'steering.applied',
        payload: { directiveIds: [directiveId], delivery: 'active_main' },
      });
    });
    if (event) {
      await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
    }
    return Boolean(event);
  }

  public enqueueFollowUp(runId: string, content: string): Promise<EnqueueRunDirectiveResult> {
    return this.enqueueQueuedFollowUp(runId, content);
  }

  public async cancelFollowUp(runId: string, followUpId: string): Promise<boolean> {
    const rows = await this.options.database
      .update(queuedFollowups)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(queuedFollowups.id, followUpId),
          eq(queuedFollowups.runId, runId),
          eq(queuedFollowups.status, 'pending'),
        ),
      )
      .returning({ id: queuedFollowups.id });
    return rows.length === 1;
  }

  public async cancelSteering(runId: string, directiveId: string): Promise<boolean> {
    const event = await this.options.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(runDirectives)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(runDirectives.id, directiveId),
            eq(runDirectives.runId, runId),
            eq(runDirectives.kind, 'steering'),
            eq(runDirectives.status, 'pending'),
          ),
        )
        .returning({ id: runDirectives.id });
      if (rows.length === 0) return undefined;
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'steering.cancelled',
        payload: { directiveId },
      });
    });
    if (event)
      await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
    return Boolean(event);
  }

  public async listEvents(runId: string, afterSequence = 0): Promise<readonly DurableRunEvent[]> {
    const events = await this.options.database
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.sequence, afterSequence)))
      .orderBy(asc(runEvents.sequence));
    return events.map(toDurableEvent);
  }

  public async getProjection(runId: string): Promise<RunProjection | undefined> {
    const runRows = await this.options.database
      .select({
        runId: agentRuns.id,
        rootMessageId: rootRequests.messageId,
        status: agentRuns.status,
        mode: agentRuns.mode,
        revisionNumber: planRevisions.revisionNumber,
        createdAt: agentRuns.createdAt,
        completedAt: agentRuns.completedAt,
      })
      .from(agentRuns)
      .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
      .leftJoin(planRevisions, eq(planRevisions.id, agentRuns.activePlanRevisionId))
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const run = runRows[0];
    if (!run) return undefined;
    const [
      events,
      artifactRows,
      evidenceRows,
      questionRows,
      approvalRows,
      proposalRows,
      steeringRows,
      followUpRows,
      modelRows,
      checkpointRows,
    ] = await Promise.all([
      this.listEvents(runId),
      this.options.database
        .select({
          id: artifacts.id,
          type: artifacts.type,
          title: artifacts.title,
          version: artifactVersions.version,
          summary: artifactVersions.summary,
        })
        .from(artifacts)
        .innerJoin(
          artifactVersions,
          and(
            eq(artifactVersions.artifactId, artifacts.id),
            eq(artifactVersions.version, artifacts.currentVersion),
          ),
        )
        .where(eq(artifacts.runId, runId)),
      this.options.database
        .select({
          id: evidenceRecords.id,
          title: evidenceRecords.title,
          source: evidenceRecords.sourceUri,
          excerpt: evidenceRecords.excerpt,
          sourceRevision: evidenceRecords.sourceRevision,
          metadata: evidenceRecords.metadata,
        })
        .from(evidenceRecords)
        .where(eq(evidenceRecords.runId, runId)),
      this.options.database
        .select()
        .from(runQuestions)
        .where(and(eq(runQuestions.runId, runId), eq(runQuestions.status, 'pending')))
        .limit(1),
      this.options.database
        .select({
          id: approvals.id,
          toolCallId: approvals.toolCallId,
          sideEffect: approvals.displayedSideEffect,
          estimatedCost: approvals.estimatedCost,
          expiresAt: approvals.expiresAt,
        })
        .from(approvals)
        .innerJoin(toolCalls, eq(toolCalls.id, approvals.toolCallId))
        .where(and(eq(toolCalls.runId, runId), eq(approvals.decision, 'pending')))
        .orderBy(asc(approvals.createdAt)),
      this.options.database
        .select({
          id: editProposals.id,
          status: editProposals.status,
          expiresAt: editProposals.expiresAt,
        })
        .from(editProposals)
        .where(eq(editProposals.runId, runId)),
      this.options.database
        .select({
          id: runDirectives.id,
          content: runDirectives.content,
          sequence: runDirectives.sequence,
          createdAt: runDirectives.createdAt,
        })
        .from(runDirectives)
        .where(and(eq(runDirectives.runId, runId), eq(runDirectives.status, 'pending')))
        .orderBy(asc(runDirectives.sequence)),
      this.options.database
        .select({
          id: queuedFollowups.id,
          content: queuedFollowups.content,
          sequence: queuedFollowups.sequence,
          createdAt: queuedFollowups.createdAt,
        })
        .from(queuedFollowups)
        .where(and(eq(queuedFollowups.runId, runId), eq(queuedFollowups.status, 'pending')))
        .orderBy(asc(queuedFollowups.sequence)),
      this.options.database
        .select({
          purpose: modelSelections.purpose,
          selectedModel: modelSelections.selectedModel,
          policySnapshot: modelSelections.policySnapshot,
          fallbackUsed: modelSelections.fallbackUsed,
        })
        .from(modelSelections)
        .where(eq(modelSelections.runId, runId))
        .orderBy(asc(modelSelections.createdAt)),
      this.options.database
        .select({
          sequence: checkpoints.sequence,
          reason: checkpoints.reason,
          createdAt: checkpoints.createdAt,
        })
        .from(checkpoints)
        .where(eq(checkpoints.runId, runId))
        .orderBy(desc(checkpoints.sequence))
        .limit(1),
    ]);
    const question = questionRows[0];
    const proposalStatuses = new Map<string, ProposalProjectionStatus>(
      proposalRows.map((proposal) => [
        proposal.id,
        proposal.status === 'pending' && proposal.expiresAt <= this.now()
          ? 'expired'
          : proposal.status,
      ]),
    );
    const pendingInteraction = question
      ? { type: 'ask-user', id: question.id, question: question.prompt, options: question.options }
      : approvalRows.length > 0
        ? { type: 'tool-approval', approvals: approvalRows }
        : undefined;
    const queuedEvent = events.find(({ eventType }) => eventType === 'run.queued');
    const contextManifest = queuedEvent?.payload.contextManifest;
    const model = modelRows[0];
    const executionFacts = projectRunExecutionFacts({
      runId,
      events,
      modelSelections: modelRows,
      createdAt: run.createdAt,
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    });
    const latestCheckpoint = checkpointRows[0];
    const progress = projectRunProgress({
      runId,
      mode: run.mode,
      status: run.status,
      events,
      ...(pendingInteraction ? { pendingInteraction } : {}),
      ...(latestCheckpoint ? { recoveryPoint: latestCheckpoint } : {}),
    });
    return {
      runId,
      rootMessageId: run.rootMessageId,
      status: run.status,
      terminal: isTerminalRunStatus(run.status),
      mode: run.mode,
      ...(run.revisionNumber ? { activePlanRevision: run.revisionNumber } : {}),
      parts: [
        ...projectRunParts(events, proposalStatuses).filter(({ type }) => type !== 'usage'),
        ...(progress ? [progress] : []),
        ...(executionFacts ? [executionFacts] : []),
        ...evidenceRows.map((evidence) => {
          const toolCallId =
            typeof evidence.metadata.toolCallId === 'string'
              ? evidence.metadata.toolCallId
              : undefined;
          const sourceEvent = toolCallId
            ? events.find(
                (event) =>
                  event.eventType === 'tool.succeeded' && event.payload.toolCallId === toolCallId,
              )
            : undefined;
          return {
            id: evidence.id,
            runId,
            sequence: sourceEvent?.sequence ?? 0,
            type: 'evidence' as const,
            status: 'evidence.available',
            payload: evidence,
          };
        }),
        ...artifactRows.map((artifact) => {
          const sourceEvent = events.find(
            (event) =>
              event.eventType === 'task.succeeded' &&
              Array.isArray(event.payload.artifacts) &&
              event.payload.artifacts.some(
                (candidate) => artifactIdFromEvent(candidate) === artifact.id,
              ),
          );
          return {
            id: artifact.id,
            runId,
            sequence: sourceEvent?.sequence ?? 0,
            type: 'artifact' as const,
            status: 'artifact.available',
            payload: artifact,
          };
        }),
        ...(run.status === 'failed' &&
        [...proposalStatuses.values()].some(
          (status) => status === 'pending' || status === 'partially_accepted',
        )
          ? [
              {
                id: `${runId}:pending-draft-preserved`,
                runId,
                sequence: events.at(-1)?.sequence ?? 0,
                type: 'warning' as const,
                status: 'run.failed',
                payload: { pendingDraft: true },
              },
            ]
          : []),
      ],
      artifacts: artifactRows,
      ...(contextManifest && typeof contextManifest === 'object'
        ? {
            context: {
              manifest: contextManifest,
              contextHash: queuedEvent.payload.contextHash,
              ...(model
                ? {
                    model: model.selectedModel,
                    provider: model.policySnapshot.provider,
                    contextWindow: model.policySnapshot.contextWindow,
                    maxOutputTokens: model.policySnapshot.maxOutputTokens,
                    fallbackUsed: model.fallbackUsed,
                  }
                : {}),
            },
          }
        : {}),
      ...(pendingInteraction ? { pendingInteraction } : {}),
      pendingDirectives: [
        ...steeringRows.map((directive) => ({
          ...directive,
          kind: 'steering' as const,
          createdAt: directive.createdAt.toISOString(),
        })),
        ...followUpRows.map((directive) => ({
          ...directive,
          kind: 'follow_up' as const,
          createdAt: directive.createdAt.toISOString(),
        })),
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      lastEventId: events.at(-1)?.sequence ?? 0,
      createdAt: run.createdAt.toISOString(),
      ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    };
  }

  public async getArtifact(
    runId: string,
    artifactId: string,
    expectedVersion?: number,
  ): Promise<ArtifactLookupResult> {
    return this.artifactQueries.get(runId, artifactId, expectedVersion);
  }

  public async listRuns(conversationId: string, branchId: string, userId: string) {
    const messages = await this.listMessages(conversationId, branchId, userId);
    if (messages.length === 0) return [];
    const rows = await this.options.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.branchId, branchId))
      .orderBy(asc(agentRuns.createdAt));
    const projections = await Promise.all(rows.map(({ id }) => this.getProjection(id)));
    return projections.filter((projection): projection is RunProjection => Boolean(projection));
  }

  public async answerQuestion(runId: string, questionId: string, answer: string, userId: string) {
    const value = answer.trim();
    if (!value || value.length > 100_000)
      throw new AgentApplicationError(
        'invalid_directive',
        'Answer must contain 1-100000 characters',
      );
    const persisted = await this.options.database.transaction(async (transaction) => {
      const now = this.now();
      const rows = await transaction
        .update(runQuestions)
        .set({ status: 'answered', answer: value, answeredByUserId: userId, answeredAt: now })
        .where(
          and(
            eq(runQuestions.id, questionId),
            eq(runQuestions.runId, runId),
            eq(runQuestions.status, 'pending'),
          ),
        )
        .returning({ id: runQuestions.id });
      if (rows.length === 0)
        throw new AgentApplicationError('invalid_directive', 'Question is no longer pending');
      await transaction
        .update(agentRuns)
        .set({ status: 'recovering', updatedAt: now, version: sql`${agentRuns.version} + 1` })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'waiting_for_user')));
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'user.input_received',
        payload: { questionId },
      });
      const outboxId = this.createId();
      await enqueueOutboxMessage(transaction, {
        id: outboxId,
        aggregateType: 'AgentRun',
        aggregateId: runId,
        topic: AGENT_RUN_COMMAND_TOPIC,
        messageKey: runId,
        payload: { command: 'run.execute', messageId: outboxId, runId },
        occurredAt: now,
      });
      return toDurableEvent(event);
    });
    await this.options.publisher.publish({ durable: true, event: persisted });
    return { questionId, runId, status: 'answered' as const };
  }

  private async loadExecutionContext(runId: string): Promise<
    | {
        readonly branchId: string;
        readonly prompt: string;
        readonly history: readonly RuntimeMessage[];
        readonly status: string;
        readonly mode: 'direct' | 'planned';
        readonly contextContent: string;
        readonly actionEnvelope: ActionEnvelopeV1;
        readonly contextPack: {
          readonly content: string;
          readonly contentHash: string;
          readonly format: string;
          readonly schemaVersion: number;
          readonly manifest: Readonly<Record<string, unknown>>;
        };
        readonly timestamp: number;
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
        actionEnvelope: rootRequests.actionEnvelope,
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
      .orderBy(desc(conversationMessages.sequence))
      .limit(12);
    const history = projectConversationHistory(
      historyRows.reverse().flatMap(({ content }) => {
        const message = decodeRuntimeMessage(content);
        return message ? [message] : [];
      }),
    );
    const contextPack = await this.contexts.load(runId);
    if (!contextPack) throw new Error(`Agent Run ${runId} has no persisted Context Pack`);
    const answeredQuestions = await this.options.database
      .select({ prompt: runQuestions.prompt, answer: runQuestions.answer })
      .from(runQuestions)
      .where(and(eq(runQuestions.runId, runId), eq(runQuestions.status, 'answered')))
      .orderBy(asc(runQuestions.createdAt));
    const promptWithAnswers = answeredQuestions.reduce(
      (current, question) =>
        `${current}\n\n<user-answer question=${JSON.stringify(question.prompt)}>${question.answer ?? ''}</user-answer>`,
      rootMessage.content,
    );

    return {
      branchId: run.branchId,
      prompt: promptWithAnswers,
      history,
      status: run.status,
      mode: run.mode,
      contextContent: contextPack.content,
      actionEnvelope: parseActionEnvelope(run.actionEnvelope),
      contextPack: {
        content: contextPack.content,
        contentHash: contextPack.contentHash,
        format: 'json',
        schemaVersion: 1,
        manifest: contextPack.manifest,
      },
      timestamp: rootMessage.timestamp,
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

  private async enqueueQueuedFollowUp(
    runId: string,
    rawContent: string,
  ): Promise<EnqueueRunDirectiveResult> {
    const content = rawContent.trim();
    if (content.length === 0 || content.length > 100_000) {
      throw new AgentApplicationError(
        'invalid_directive',
        'Follow-up must contain between 1 and 100000 characters',
      );
    }
    const persisted = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from ${agentRuns} where id = ${runId} for update`);
      const rows = await transaction
        .select({ status: agentRuns.status, userId: rootRequests.requestedByUserId })
        .from(agentRuns)
        .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const run = rows[0];
      if (!run)
        throw new AgentApplicationError('run_not_found', `Agent Run ${runId} does not exist`);
      if (!run.userId) {
        throw new AgentApplicationError('unauthorized_user', 'Agent Run has no requesting user');
      }
      if (TERMINAL_RUN_STATES.includes(run.status as (typeof TERMINAL_RUN_STATES)[number])) {
        throw new AgentApplicationError(
          'invalid_directive',
          'A terminal Run cannot accept a follow-up',
        );
      }
      const sequences = await transaction
        .select({ sequence: max(queuedFollowups.sequence) })
        .from(queuedFollowups)
        .where(eq(queuedFollowups.runId, runId));
      const sequence = (sequences[0]?.sequence ?? 0) + 1;
      const followUpId = this.createId();
      await transaction.insert(queuedFollowups).values({
        id: followUpId,
        runId,
        sequence,
        content,
        requestedByUserId: run.userId,
      });
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'follow_up.queued',
        payload: { followUpId, sequence },
      });
      return {
        result: {
          directiveId: followUpId,
          runId,
          kind: 'follow_up' as const,
          sequence,
          status: 'pending' as const,
        },
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
    const terminalOutcome = classifyTerminalOutcome(result);
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

      if (terminalOutcome === 'completed' && currentStatus !== 'cancelling') {
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

      if (terminalOutcome === 'cancelled' || currentStatus === 'cancelling') {
        await transaction
          .update(runDirectives)
          .set({ status: 'cancelled' })
          .where(and(eq(runDirectives.runId, runId), eq(runDirectives.status, 'pending')));
        await transaction
          .update(queuedFollowups)
          .set({ status: 'cancelled' })
          .where(and(eq(queuedFollowups.runId, runId), eq(queuedFollowups.status, 'pending')));
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
        );
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

    const terminal = durableEvents.at(-1)?.eventType;
    if (terminal !== 'run.cancelled') await this.activateNextFollowUp(branchId);
    for (const event of durableEvents) {
      await this.options.publisher.publish({ durable: true, event });
    }
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
    return response;
  }

  private async activateNextFollowUp(branchId: string): Promise<void> {
    const rows = await this.options.database
      .select({
        id: queuedFollowups.id,
        content: queuedFollowups.content,
        branchId: agentRuns.branchId,
        conversationId: conversations.id,
        requestedByUserId: queuedFollowups.requestedByUserId,
      })
      .from(queuedFollowups)
      .innerJoin(agentRuns, eq(agentRuns.id, queuedFollowups.runId))
      .innerJoin(conversationBranches, eq(conversationBranches.id, agentRuns.branchId))
      .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
      .where(and(eq(agentRuns.branchId, branchId), eq(queuedFollowups.status, 'pending')))
      .orderBy(asc(agentRuns.createdAt), asc(queuedFollowups.sequence))
      .limit(1);
    const claimed = rows[0];
    if (!claimed) return;
    const created = await this.create({
      conversationId: claimed.conversationId,
      branchId: claimed.branchId,
      userId: claimed.requestedByUserId,
      prompt: claimed.content,
      idempotencyKey: `follow-up:${claimed.id}`,
    });
    await this.options.database
      .update(queuedFollowups)
      .set({ status: 'consumed', consumedAt: this.now(), createdRunId: created.runId })
      .where(and(eq(queuedFollowups.id, claimed.id), eq(queuedFollowups.status, 'pending')));
  }
}

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(status);
}

function encodeRuntimeMessage(message: RuntimeMessage): readonly unknown[] {
  return [{ type: 'agentpress.runtime-message', version: 1, message }];
}

function isRecoverableRunStatus(status: string): status is 'planning' | 'running' | 'interrupted' {
  return status === 'planning' || status === 'running' || status === 'interrupted';
}

function artifactIdFromEvent(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  return typeof artifact.artifactId === 'string' ? artifact.artifactId : undefined;
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

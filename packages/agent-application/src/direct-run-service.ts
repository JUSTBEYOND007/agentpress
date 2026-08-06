import { randomUUID } from 'node:crypto';

import type {
  RuntimeAssistantMessage,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeResult,
} from '@agentpress/agent-runtime';
import { RUNTIME_CURRENT_TURN_VERSION } from '@agentpress/agent-runtime';
import { loadSkill } from '@agentpress/agent-context';
import { parseActionEnvelope, type ActionEnvelopeV1 } from '@agentpress/contracts';
import {
  agentRuns,
  agentTasks,
  appendCheckpoint,
  appendRunEvent,
  cancelAgentRunTasks,
  type AgentPressDatabase,
  type DatabaseTransaction,
  conversationBranches,
  conversationMessages,
  conversations,
  enqueueOutboxMessage,
  rootRequests,
  queuedFollowups,
  runQuestions,
  runDirectives,
  runEvents,
  runToolChoices,
  skillRevisions,
  toolCalls,
  workspaceMembers,
} from '@agentpress/database';
import { and, asc, desc, eq, gte, inArray, lt, max, sql } from 'drizzle-orm';
import { decideToolReplay, resolveToolReplaySafety } from '@agentpress/tool-runtime';

import {
  AGENT_RUN_COMMAND_TOPIC,
  AgentApplicationError,
  StaleWorkerSettlementError,
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
  type SelectedSkillInput,
  type SkillPreselectionCandidate,
  type SkillPreselector,
} from './contracts.js';
import { classifyTerminalOutcome } from './terminal-outcome-policy.js';
import { PlannedRunExecutor } from './planned-run-executor.js';
import {
  projectConversationHistory,
  readConversationCompactionBoundary,
} from './agent-transcript-projector.js';
import { RunContextService } from './run-context-service.js';
import { ArtifactQueryService, type ArtifactLookupResult } from './artifact-query-service.js';
import {
  ConversationCompactionService,
  type ConversationCompactionResult,
} from './conversation-compaction-service.js';
import { AgentRegistryService } from './agent-registry.js';
import { RunProjectionService, isTerminalRunStatus } from './run-projection-service.js';
import { ConversationBranchService } from './conversation-branch-service.js';
import { decodeRuntimeMessage, encodeRuntimeMessage } from './runtime-message-codec.js';

export { isTerminalRunStatus } from './run-projection-service.js';

type DirectRunServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly runtimeFactory: AgentRuntimeFactory;
  readonly publisher: RunEventPublisher;
  readonly systemPrompt: string;
  readonly runtimeToolFactory?: RuntimeToolFactory;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly maxSpecialistConcurrency?: number;
  /** Disable outbox dispatch only for isolated evaluation harnesses. Production defaults to true. */
  readonly dispatchCommands?: boolean;
  /** Optional Pi-backed chooser. The host validates its result before pinning context. */
  readonly skillPreselector?: SkillPreselector;
};

export class DirectRunService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly plannedRuns: PlannedRunExecutor;
  private readonly contexts: RunContextService;
  private readonly artifactQueries: ArtifactQueryService;
  private readonly compactions: ConversationCompactionService;
  private readonly registry: AgentRegistryService;
  private readonly projections: RunProjectionService;
  private readonly branches: ConversationBranchService;

  public constructor(private readonly options: DirectRunServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.plannedRuns = new PlannedRunExecutor(options);
    this.artifactQueries = new ArtifactQueryService(options.database);
    this.registry = new AgentRegistryService(options.database);
    this.projections = new RunProjectionService(options.database, this.now);
    this.branches = new ConversationBranchService(options.database, this.createId);
    this.compactions = new ConversationCompactionService({
      database: options.database,
      runtimeFactory: options.runtimeFactory,
      createId: this.createId,
    });
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
    return this.branches.listMessages(conversationId, branchId, userId);
  }

  public async forkBranch(
    conversationId: string,
    branchId: string,
    messageId: string,
    userId: string,
  ) {
    return this.branches.fork(conversationId, branchId, messageId, userId);
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

      const explicitSkills = collectSkillSelections(input);
      const candidates = this.options.skillPreselector
        ? await loadSkillPreselectionCandidates(transaction, branch.workspaceId)
        : [];
      const modelSkills = this.options.skillPreselector
        ? validateModelSkillSelections(
            candidates,
            await this.options.skillPreselector.select({
              prompt,
              explicitSkills,
              candidates,
              maxSelections: 8,
            }),
          )
        : [];
      const selectedSkills = mergeSkillSelections(explicitSkills, modelSkills);

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
            .select({
              id: conversationMessages.id,
              content: conversationMessages.content,
              sequence: conversationMessages.sequence,
            })
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
        branchId: input.branchId,
        rootMessageSequence: existingRoot?.sequence ?? messageSequence,
        query: prompt,
        workspaceId: branch.workspaceId,
        userId: input.userId,
        mentionTargetIds: input.mentionTargetIds ?? [],
        attachmentIds: input.attachmentIds ?? [],
        skills: selectedSkills,
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
      if (this.options.skillPreselector) {
        await appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType: 'skill.selection.completed',
          payload: {
            explicit: explicitSkills,
            model: modelSkills,
            selected: selectedSkills,
          },
        });
      }
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
        return { result: { outcome: 'not_found' as const, runId }, events: [] };
      }
      if (isTerminalRunStatus(current.status)) {
        return {
          result: { outcome: 'already_terminal' as const, runId, status: current.status },
          events: [],
        };
      }
      if (current.status === 'cancelling') {
        return {
          result: { outcome: 'accepted' as const, runId, status: 'cancelling' as const },
          events: [],
        };
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
        return {
          result: { outcome: 'already_terminal' as const, runId, status: current.status },
          events: [],
        };
      }
      const now = this.now();
      const cancelledTasks = await cancelAgentRunTasks(transaction, { runId, now });
      const taskEvents: DurableRunEvent[] = [];
      for (const task of cancelledTasks) {
        const taskEvent = await appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType: 'task.cancelled',
          payload: {
            taskId: task.taskId,
            attempt: task.attempt,
            reason: 'run_cancelled',
          },
        });
        taskEvents.push(toDurableEvent(taskEvent));
      }
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.cancelling',
        payload: {},
      });
      return {
        result: { outcome: 'accepted' as const, runId, status: 'cancelling' as const },
        events: [...taskEvents, toDurableEvent(event)],
      };
    });

    for (const event of settled.events) {
      await this.options.publisher.publish({ durable: true, event });
    }
    return settled.result;
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
      const recoveredToolChoices = await transaction
        .update(runToolChoices)
        .set({
          status: 'pending',
          claimToken: null,
          claimedAt: null,
          rejectionReason: null,
          recoveryCount: sql`${runToolChoices.recoveryCount} + 1`,
        })
        .where(and(eq(runToolChoices.runId, runId), eq(runToolChoices.status, 'in_flight')))
        .returning({ id: runToolChoices.id });
      const executing = await transaction
        .select({
          id: toolCalls.id,
          risk: toolCalls.risk,
          idempotencyKey: toolCalls.idempotencyKey,
        })
        .from(toolCalls)
        .where(and(eq(toolCalls.runId, runId), eq(toolCalls.status, 'executing')));
      const events: DurableRunEvent[] = [];
      const replayReadyToolCalls: string[] = [];
      for (const call of executing) {
        const safety = resolveToolReplaySafety({
          risk: call.risk,
          // A persisted key proves only that AgentPress can identify the call. It does
          // not prove the external provider committed that key atomically with its side effect.
          idempotency: call.risk === 'read_only' && call.idempotencyKey ? 'provider_key' : 'none',
        });
        const action = decideToolReplay({
          status: 'executing',
          safety,
          ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
        });
        if (action === 'resume') {
          await transaction
            .update(toolCalls)
            .set({
              status: 'approved',
              failure: null,
              settledAt: null,
              updatedAt: now,
              version: sql`${toolCalls.version} + 1`,
            })
            .where(and(eq(toolCalls.id, call.id), eq(toolCalls.status, 'executing')));
          const toolEvent = await appendRunEvent(transaction, {
            id: this.createId(),
            runId,
            eventType: 'tool.recovery_ready',
            payload: { toolCallId: call.id, reason: 'worker_lease_lost', action, safety },
          });
          events.push(toDurableEvent(toolEvent));
          replayReadyToolCalls.push(call.id);
          continue;
        }
        const status = 'outcome_unknown' as const;
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
          payload: { toolCallId: call.id, reason: 'worker_lease_lost', action, safety },
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
        state: {
          previousStatus: run.status,
          interruptedToolCalls: executing.map(({ id }) => id),
          replayReadyToolCalls,
          recoveredToolChoices: recoveredToolChoices.map(({ id }) => id),
        },
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

  /** Executes one persisted detached Specialist Task after a worker claims it. */
  public async executeDetachedTask(
    runId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'not_found'> {
    return this.plannedRuns.executeDetachedTask(runId, taskId, signal);
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

  public async compactConversation(
    conversationId: string,
    branchId: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<ConversationCompactionResult> {
    const membership = await this.options.database
      .select({ role: workspaceMembers.role })
      .from(conversationBranches)
      .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, conversations.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .where(and(eq(conversationBranches.id, branchId), eq(conversations.id, conversationId)))
      .limit(1);
    if (!membership[0]) {
      throw new AgentApplicationError(
        'unauthorized_user',
        'User cannot compact a conversation outside their workspace',
      );
    }
    return this.compactions.compact({
      branchId,
      reason: 'manual',
      force: true,
      ...(signal ? { signal } : {}),
    });
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
    return this.projections.listEvents(runId, afterSequence);
  }
  public async getProjection(runId: string): Promise<RunProjection | undefined> {
    return this.projections.get(runId);
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

    const contextPack = await this.contexts.load(runId);
    if (!contextPack) throw new Error(`Agent Run ${runId} has no persisted Context Pack`);
    const compactedBoundary = readConversationCompactionBoundary(
      contextPack.manifest,
      run.branchId,
      run.messageSequence,
    );
    const historyRows = await this.options.database
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.branchId, run.branchId),
          eq(conversationMessages.stable, true),
          lt(conversationMessages.sequence, run.messageSequence),
          ...(compactedBoundary === undefined
            ? []
            : [gte(conversationMessages.sequence, compactedBoundary)]),
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
      if (isTerminalRunStatus(run.status)) {
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
      if (isTerminalRunStatus(run.status)) {
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
      await transaction.execute(sql`select id from ${agentRuns} where id = ${runId} for update`);
      const statusRows = await transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const currentStatus = statusRows[0]?.status;
      const now = this.now();
      const events: DurableRunEvent[] = [];

      if (currentStatus === 'recovering' || currentStatus === 'interrupted') {
        throw new StaleWorkerSettlementError(runId);
      }

      if (terminalOutcome === 'completed' && currentStatus === 'running') {
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
          .update(runToolChoices)
          .set({
            status: 'cancelled',
            rejectionReason: 'run_settled',
            settledAt: now,
          })
          .where(
            and(
              eq(runToolChoices.runId, runId),
              inArray(runToolChoices.status, ['pending', 'in_flight']),
            ),
          );
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
        const cancelledTasks = await cancelAgentRunTasks(transaction, { runId, now });
        for (const task of cancelledTasks) {
          const taskEvent = await appendRunEvent(transaction, {
            id: this.createId(),
            runId,
            eventType: 'task.cancelled',
            payload: {
              taskId: task.taskId,
              attempt: task.attempt,
              reason: 'run_cancelled',
            },
          });
          events.push(toDurableEvent(taskEvent));
        }
        await transaction
          .update(runToolChoices)
          .set({
            status: 'cancelled',
            rejectionReason: 'cancelled',
            settledAt: now,
          })
          .where(
            and(
              eq(runToolChoices.runId, runId),
              inArray(runToolChoices.status, ['pending', 'in_flight']),
            ),
          );
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
        .update(runToolChoices)
        .set({
          status: 'cancelled',
          rejectionReason: 'run_failed',
          settledAt: now,
        })
        .where(
          and(
            eq(runToolChoices.runId, runId),
            inArray(runToolChoices.status, ['pending', 'in_flight']),
          ),
        );
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
    const compactionEvent =
      terminal === 'run.cancelled' ? undefined : await this.compactAfterSettlement(branchId, runId);
    if (terminal !== 'run.cancelled') await this.activateNextFollowUp(branchId);
    for (const event of durableEvents) {
      await this.options.publisher.publish({ durable: true, event });
    }
    if (compactionEvent) {
      await this.options.publisher.publish({ durable: true, event: compactionEvent });
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

  private async compactAfterSettlement(
    branchId: string,
    runId: string,
  ): Promise<DurableRunEvent | undefined> {
    try {
      const result = await this.compactions.compact({ branchId, reason: 'automatic' });
      if (result.status === 'not_needed') return undefined;
      const persisted = await this.options.database.transaction((transaction) =>
        appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType:
            result.status === 'completed'
              ? 'conversation.compaction_completed'
              : 'conversation.compaction_failed',
          payload: { compactionId: result.compactionId, version: result.version },
        }),
      );
      return toDurableEvent(persisted);
    } catch (error) {
      const persisted = await this.options.database.transaction((transaction) =>
        appendRunEvent(transaction, {
          id: this.createId(),
          runId,
          eventType: 'conversation.compaction_failed',
          payload: {
            code: 'persistence_error',
            message: error instanceof Error ? error.message : 'Conversation compaction failed',
          },
        }),
      );
      return toDurableEvent(persisted);
    }
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

function collectSkillSelections(input: CreateDirectRunInput): readonly SelectedSkillInput[] {
  return normalizeSkillSelections([
    ...(input.skills ?? []),
    ...(input.contextBindings ?? []).flatMap((binding) =>
      binding.type === 'skill' ? [{ skillId: binding.skillId, version: binding.version }] : [],
    ),
  ]);
}

function mergeSkillSelections(
  explicit: readonly SelectedSkillInput[],
  model: readonly SelectedSkillInput[],
): readonly SelectedSkillInput[] {
  const selected = new Map(normalizeSkillSelections(explicit).map((item) => [item.skillId, item]));
  for (const selection of model) {
    const current = selected.get(selection.skillId);
    if (current) continue;
    selected.set(selection.skillId, selection);
  }
  if (selected.size > 8) {
    throw new AgentApplicationError('invalid_context', 'A Run can select at most 8 Skills');
  }
  return [...selected.values()].sort((left, right) => left.skillId.localeCompare(right.skillId));
}

function normalizeSkillSelections(
  selections: readonly SelectedSkillInput[],
): readonly SelectedSkillInput[] {
  const selected = new Map<string, SelectedSkillInput>();
  for (const selection of selections) {
    const current = selected.get(selection.skillId);
    if (current && current.version !== selection.version) {
      throw new AgentApplicationError(
        'invalid_context',
        `Skill ${selection.skillId} cannot use multiple revisions in one Run`,
      );
    }
    selected.set(selection.skillId, selection);
  }
  return [...selected.values()];
}

function validateModelSkillSelections(
  candidates: readonly SkillPreselectionCandidate[],
  selections: readonly SelectedSkillInput[],
): readonly SelectedSkillInput[] {
  const byId = new Map(candidates.map((candidate) => [candidate.skillId, candidate]));
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.skillId)) {
      throw new AgentApplicationError(
        'invalid_context',
        `Model selected Skill ${selection.skillId} more than once`,
      );
    }
    seen.add(selection.skillId);
    const candidate = byId.get(selection.skillId);
    if (
      candidate?.version !== selection.version ||
      candidate.hidden ||
      candidate.disableModelInvocation
    ) {
      throw new AgentApplicationError(
        'invalid_context',
        `Model selected unavailable Skill ${selection.skillId}@${selection.version}`,
      );
    }
  }
  return [...selections];
}

async function loadSkillPreselectionCandidates(
  transaction: DatabaseTransaction,
  workspaceId: string,
): Promise<readonly SkillPreselectionCandidate[]> {
  const rows = await transaction
    .select()
    .from(skillRevisions)
    .where(eq(skillRevisions.workspaceId, workspaceId))
    .orderBy(skillRevisions.skillId, desc(skillRevisions.createdAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latest.has(row.skillId)) latest.set(row.skillId, row);
  }
  return [...latest.values()].map((row) => {
    const skill = loadSkill(row.content);
    if (skill.id !== row.skillId || skill.version !== row.version) {
      throw new AgentApplicationError(
        'invalid_context',
        `Stored Skill ${row.skillId}@${row.version} has an invalid identity`,
      );
    }
    return {
      skillId: row.skillId,
      version: row.version,
      description: skill.description,
      allowedTools: row.allowedTools,
      hidden: skill.hidden === true,
      disableModelInvocation: skill.disableModelInvocation === true,
    };
  });
}

function isRecoverableRunStatus(status: string): status is 'planning' | 'running' | 'interrupted' {
  return status === 'planning' || status === 'running' || status === 'interrupted';
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

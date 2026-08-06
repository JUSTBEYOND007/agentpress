import { randomUUID } from 'node:crypto';

import type { RuntimeEvent, RuntimeMessage, RuntimeResult } from '@agentpress/agent-runtime';
import { RUNTIME_CURRENT_TURN_VERSION } from '@agentpress/agent-runtime';
import { loadSkill } from '@agentpress/agent-context';
import { parseActionEnvelope, type ActionEnvelopeV1 } from '@agentpress/contracts';
import {
  agentRuns,
  appendRunEvent,
  type AgentPressDatabase,
  type DatabaseTransaction,
  conversationBranches,
  conversationMessages,
  conversations,
  enqueueOutboxMessage,
  rootRequests,
  queuedFollowups,
  runQuestions,
  runEvents,
  skillRevisions,
  workspaceMembers,
} from '@agentpress/database';
import { and, asc, desc, eq, gte, lt, max, sql } from 'drizzle-orm';

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
  type SelectedSkillInput,
  type SkillPreselectionCandidate,
  type SkillPreselector,
} from './contracts.js';
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
import { RunInteractionService } from './run-interaction-service.js';
import { RunRecoveryService } from './run-recovery-service.js';
import { RunSettlementService } from './run-settlement-service.js';

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
  private readonly interactions: RunInteractionService;
  private readonly recovery: RunRecoveryService;
  private readonly settlements: RunSettlementService;

  public constructor(private readonly options: DirectRunServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.plannedRuns = new PlannedRunExecutor(options);
    this.artifactQueries = new ArtifactQueryService(options.database);
    this.registry = new AgentRegistryService(options.database);
    this.projections = new RunProjectionService(options.database, this.now);
    this.branches = new ConversationBranchService(options.database, this.createId);
    this.interactions = new RunInteractionService({
      database: options.database,
      publisher: options.publisher,
      createId: this.createId,
      now: this.now,
      steerActiveMain: (runId, content) => this.plannedRuns.steerActiveMain(runId, content),
    });
    this.recovery = new RunRecoveryService({
      database: options.database,
      publisher: options.publisher,
      createId: this.createId,
      now: this.now,
    });
    this.compactions = new ConversationCompactionService({
      database: options.database,
      runtimeFactory: options.runtimeFactory,
      createId: this.createId,
    });
    this.settlements = new RunSettlementService({
      database: options.database,
      publisher: options.publisher,
      createId: this.createId,
      now: this.now,
      compactConversation: (branchId) =>
        this.compactions.compact({ branchId, reason: 'automatic' }),
      activateNextFollowUp: (branchId) => this.activateNextFollowUp(branchId),
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

  public requestCancellation(runId: string): Promise<RequestRunCancellationResult> {
    return this.recovery.requestCancellation(runId);
  }

  public prepareRecovery(runId: string): Promise<boolean> {
    return this.recovery.prepare(runId);
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
    return this.interactions.enqueueSteering(runId, content);
  }

  public steerActiveMain(runId: string, directiveId: string, content: string): Promise<boolean> {
    return this.interactions.steerActiveMain(runId, directiveId, content);
  }

  public enqueueFollowUp(runId: string, content: string): Promise<EnqueueRunDirectiveResult> {
    return this.interactions.enqueueFollowUp(runId, content);
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

  public cancelFollowUp(runId: string, followUpId: string): Promise<boolean> {
    return this.interactions.cancelFollowUp(runId, followUpId);
  }

  public cancelSteering(runId: string, directiveId: string): Promise<boolean> {
    return this.interactions.cancelSteering(runId, directiveId);
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

  public answerQuestion(runId: string, questionId: string, answer: string, userId: string) {
    return this.interactions.answerQuestion(runId, questionId, answer, userId);
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

  private settleRun(
    branchId: string,
    runId: string,
    result: RuntimeResult,
    completedWithDegradation = false,
  ): Promise<ExecuteDirectRunResult> {
    return this.settlements.settle(branchId, runId, result, completedWithDegradation);
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

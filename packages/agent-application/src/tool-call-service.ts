import { randomUUID } from 'node:crypto';

import {
  agentRuns,
  agentTasks,
  appendCheckpoint,
  appendRunEvent,
  approvals,
  type AgentPressDatabase,
  enqueueOutboxMessage,
  toolCalls,
} from '@agentpress/database';
import { hashToolArguments, ToolExecutionError, ToolRegistry } from '@agentpress/tool-runtime';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  AGENT_RUN_COMMAND_TOPIC,
  type DurableRunEvent,
  type RunEventPublisher,
} from './contracts.js';

const APPROVAL_RISKS = new Set(['external_write', 'destructive']);

export class ToolCallApplicationError extends Error {
  public constructor(
    public readonly code:
      | 'run_not_found'
      | 'tool_call_not_found'
      | 'approval_not_found'
      | 'approval_expired'
      | 'approval_mismatch'
      | 'approval_denied'
      | 'invalid_tool_state'
      | 'stale_task_attempt'
      | 'tool_replay_blocked'
      | 'unauthorized_tool',
    message: string,
  ) {
    super(message);
    this.name = 'ToolCallApplicationError';
  }
}

export type ProposeToolCallInput = {
  readonly runId: string;
  readonly taskId?: string;
  readonly taskAttempt?: number;
  readonly taskOperationKey?: string;
  readonly taskOperationOrdinal?: number;
  readonly providerToolCallId?: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly requestedFromUserId: string;
  readonly allowedCapabilities: ReadonlySet<string>;
  readonly idempotencyKey?: string;
};

export type DecideToolCallApprovalInput = {
  readonly toolCallId: string;
  readonly decision: 'approved' | 'denied';
  readonly userId: string;
};

type ToolCallServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly registry: ToolRegistry;
  readonly publisher: RunEventPublisher;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly approvalTtlMs?: number;
};

export class ToolCallService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly approvalTtlMs: number;

  public constructor(private readonly options: ToolCallServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.approvalTtlMs = options.approvalTtlMs ?? 15 * 60_000;
  }

  public async propose(input: ProposeToolCallInput): Promise<{
    readonly toolCallId: string;
    readonly status: 'proposed' | 'awaiting_approval' | 'blocked';
    readonly blockedStatus?:
      | 'denied'
      | 'expired'
      | 'executing'
      | 'failed'
      | 'outcome_unknown'
      | 'cancelled';
    readonly approvalId?: string;
    readonly argumentsHash: string;
  }> {
    const hasTaskOperation = input.taskOperationKey !== undefined;
    if (
      (input.taskId === undefined) !== (input.taskAttempt === undefined) ||
      (hasTaskOperation &&
        (!input.taskId ||
          !input.taskAttempt ||
          !input.taskOperationOrdinal ||
          input.idempotencyKey !== input.taskOperationKey)) ||
      (!hasTaskOperation && input.taskOperationOrdinal !== undefined)
    ) {
      throw new TypeError('Specialist Tool Call recovery identity is incomplete');
    }
    const definition = this.options.registry.get(input.toolId, input.toolVersion);
    this.options.registry.validateInput(definition, input.arguments);
    if (!definition.capabilities.every((capability) => input.allowedCapabilities.has(capability))) {
      throw new ToolCallApplicationError(
        'unauthorized_tool',
        `Tool ${input.toolId} is outside the effective capability policy`,
      );
    }
    const argumentsHash = hashToolArguments(input.arguments);
    const toolCallId = this.createId();
    const requiresApproval = APPROVAL_RISKS.has(definition.risk);
    const approvalId = requiresApproval ? this.createId() : undefined;
    const now = this.now();
    const status = requiresApproval ? ('awaiting_approval' as const) : ('proposed' as const);
    const persisted = await this.options.database.transaction(async (transaction) => {
      const runRows = await transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, input.runId))
        .limit(1);
      if (!runRows[0]) {
        throw new ToolCallApplicationError('run_not_found', `Agent Run ${input.runId} not found`);
      }
      if (input.taskId) {
        await transaction.execute(
          sql`select id from ${agentTasks} where id = ${input.taskId} for update`,
        );
        const taskRows = await transaction
          .select({
            runId: agentTasks.runId,
            attempt: agentTasks.attempt,
            status: agentTasks.status,
          })
          .from(agentTasks)
          .where(eq(agentTasks.id, input.taskId))
          .limit(1);
        const task = taskRows[0];
        if (
          task?.runId !== input.runId ||
          (input.taskAttempt !== undefined &&
            (task.attempt !== input.taskAttempt || task.status !== 'running'))
        ) {
          throw new ToolCallApplicationError(
            'stale_task_attempt',
            `Specialist Task ${input.taskId} attempt no longer owns execution`,
          );
        }
      }
      if (input.idempotencyKey) {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`,
        );
        const existingRows = await transaction
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.idempotencyKey, input.idempotencyKey))
          .limit(1);
        const existing = existingRows[0];
        if (existing) {
          const sameTaskOperation =
            input.taskOperationKey !== undefined &&
            existing.taskOperationKey === input.taskOperationKey &&
            existing.taskId === (input.taskId ?? null) &&
            existing.taskOperationOrdinal === (input.taskOperationOrdinal ?? null);
          if (
            existing.runId !== input.runId ||
            existing.toolId !== definition.toolId ||
            existing.toolVersion !== definition.version ||
            existing.argumentsHash !== argumentsHash ||
            (!sameTaskOperation &&
              existing.providerToolCallId !== (input.providerToolCallId ?? null))
          ) {
            throw new ToolCallApplicationError(
              'approval_mismatch',
              'Idempotency key is already bound to a different Tool Call',
            );
          }
          let existingStatus = existing.status;
          let event;
          if (
            sameTaskOperation &&
            existingStatus === 'executing' &&
            input.taskAttempt !== undefined &&
            existing.taskAttempt !== null &&
            existing.taskAttempt < input.taskAttempt &&
            existing.risk !== 'read_only'
          ) {
            const recovered = await transaction
              .update(toolCalls)
              .set({
                status: 'outcome_unknown',
                failure: {
                  message: 'A newer Specialist attempt fenced an unfinished side effect',
                  previousTaskAttempt: existing.taskAttempt,
                  recoveryTaskAttempt: input.taskAttempt,
                },
                settledAt: now,
                updatedAt: now,
                version: sql`${toolCalls.version} + 1`,
              })
              .where(and(eq(toolCalls.id, existing.id), eq(toolCalls.status, 'executing')))
              .returning({ id: toolCalls.id });
            if (recovered.length === 1) {
              existingStatus = 'outcome_unknown';
              await appendCheckpoint(transaction, {
                id: this.createId(),
                runId: input.runId,
                reason: 'tool_settled',
                state: {
                  toolCallId: existing.id,
                  status: existingStatus,
                  reason: 'specialist_attempt_recovery',
                  previousTaskAttempt: existing.taskAttempt,
                  recoveryTaskAttempt: input.taskAttempt,
                },
              });
              event = toDurableEvent(
                await appendRunEvent(transaction, {
                  id: this.createId(),
                  runId: input.runId,
                  eventType: 'tool.outcome_unknown',
                  payload: {
                    toolCallId: existing.id,
                    reason: 'specialist_attempt_recovery',
                    previousTaskAttempt: existing.taskAttempt,
                    recoveryTaskAttempt: input.taskAttempt,
                  },
                }),
              );
            }
          }
          const blocked = new Set([
            'denied',
            'expired',
            'executing',
            'failed',
            'outcome_unknown',
            'cancelled',
          ]).has(existingStatus);
          return {
            ...(event ? { event } : {}),
            result: {
              toolCallId: existing.id,
              status: blocked
                ? ('blocked' as const)
                : existingStatus === 'awaiting_approval'
                  ? ('awaiting_approval' as const)
                  : ('proposed' as const),
              ...(blocked
                ? {
                    blockedStatus: existingStatus as
                      | 'denied'
                      | 'expired'
                      | 'executing'
                      | 'failed'
                      | 'outcome_unknown'
                      | 'cancelled',
                  }
                : {}),
              argumentsHash,
            },
          };
        }
      }
      await transaction.insert(toolCalls).values({
        id: toolCallId,
        runId: input.runId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.taskAttempt ? { taskAttempt: input.taskAttempt } : {}),
        ...(input.taskOperationKey
          ? {
              taskOperationKey: input.taskOperationKey,
              taskOperationOrdinal: input.taskOperationOrdinal,
            }
          : {}),
        ...(input.providerToolCallId ? { providerToolCallId: input.providerToolCallId } : {}),
        toolId: definition.toolId,
        toolVersion: definition.version,
        arguments: input.arguments,
        argumentsHash,
        risk: definition.risk,
        sideEffect: definition.sideEffect,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        status,
        createdAt: now,
        updatedAt: now,
      });
      if (approvalId) {
        await transaction.insert(approvals).values({
          id: approvalId,
          toolCallId,
          requestedFromUserId: input.requestedFromUserId,
          toolVersion: definition.version,
          argumentsHash,
          displayedSideEffect: definition.sideEffect,
          estimatedCost: definition.estimateCost(input.arguments),
          expiresAt: new Date(now.getTime() + this.approvalTtlMs),
          createdAt: now,
        });
        await transaction
          .update(agentRuns)
          .set({
            status: 'waiting_for_approval',
            updatedAt: now,
            version: sql`${agentRuns.version} + 1`,
          })
          .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.status, 'running')));
      }
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId: input.runId,
        eventType: approvalId ? 'tool.approval_requested' : 'tool.proposed',
        payload: {
          toolCallId,
          toolId: definition.toolId,
          toolVersion: definition.version,
          arguments: input.arguments,
          argumentsHash,
          risk: definition.risk,
          sideEffect: definition.sideEffect,
          ...(approvalId ? { approvalId } : {}),
        },
      });
      return {
        event: toDurableEvent(event),
        result: { toolCallId, status, ...(approvalId ? { approvalId } : {}), argumentsHash },
      };
    });
    if (persisted.event) {
      await this.options.publisher.publish({ durable: true, event: persisted.event });
    }
    return persisted.result;
  }

  public async decideApproval(input: DecideToolCallApprovalInput): Promise<{
    readonly toolCallId: string;
    readonly decision: 'approved' | 'denied';
    readonly status: 'approved' | 'denied';
  }> {
    const persisted = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${toolCalls} where id = ${input.toolCallId} for update`,
      );
      const rows = await transaction
        .select({
          runId: toolCalls.runId,
          status: toolCalls.status,
          toolVersion: toolCalls.toolVersion,
          arguments: toolCalls.arguments,
          argumentsHash: toolCalls.argumentsHash,
          approvalId: approvals.id,
          requestedFromUserId: approvals.requestedFromUserId,
          decision: approvals.decision,
          approvalToolVersion: approvals.toolVersion,
          approvalArgumentsHash: approvals.argumentsHash,
          expiresAt: approvals.expiresAt,
        })
        .from(toolCalls)
        .innerJoin(approvals, eq(approvals.toolCallId, toolCalls.id))
        .where(eq(toolCalls.id, input.toolCallId))
        .limit(1);
      const call = rows[0];
      if (!call) {
        throw new ToolCallApplicationError(
          'approval_not_found',
          `Approval for Tool Call ${input.toolCallId} not found`,
        );
      }
      if (call.requestedFromUserId !== input.userId) {
        throw new ToolCallApplicationError('approval_mismatch', 'Approval belongs to another user');
      }
      if (call.decision !== 'pending' || call.status !== 'awaiting_approval') {
        throw new ToolCallApplicationError('invalid_tool_state', 'Approval is already settled');
      }
      if (call.expiresAt.getTime() <= this.now().getTime()) {
        const now = this.now();
        await transaction
          .update(approvals)
          .set({ decision: 'expired', decidedAt: now })
          .where(eq(approvals.id, call.approvalId));
        await transaction
          .update(toolCalls)
          .set({
            status: 'expired',
            settledAt: now,
            updatedAt: now,
            version: sql`${toolCalls.version} + 1`,
          })
          .where(eq(toolCalls.id, input.toolCallId));
        await transaction
          .update(agentRuns)
          .set({ status: 'running', updatedAt: now, version: sql`${agentRuns.version} + 1` })
          .where(and(eq(agentRuns.id, call.runId), eq(agentRuns.status, 'waiting_for_approval')));
        const event = await appendRunEvent(transaction, {
          id: this.createId(),
          runId: call.runId,
          eventType: 'tool.expired',
          payload: { toolCallId: input.toolCallId, approvalId: call.approvalId },
        });
        return { expired: true as const, event: toDurableEvent(event) };
      }
      if (
        call.toolVersion !== call.approvalToolVersion ||
        call.argumentsHash !== call.approvalArgumentsHash ||
        hashToolArguments(call.arguments) !== call.argumentsHash
      ) {
        throw new ToolCallApplicationError(
          'approval_mismatch',
          'Tool version or arguments changed after approval was requested',
        );
      }
      const now = this.now();
      await transaction
        .update(approvals)
        .set({ decision: input.decision, decidedByUserId: input.userId, decidedAt: now })
        .where(eq(approvals.id, call.approvalId));
      await transaction
        .update(toolCalls)
        .set({
          status: input.decision,
          updatedAt: now,
          ...(input.decision === 'denied' ? { settledAt: now } : {}),
          version: sql`${toolCalls.version} + 1`,
        })
        .where(eq(toolCalls.id, input.toolCallId));
      await transaction
        .update(agentRuns)
        .set({ status: 'running', updatedAt: now, version: sql`${agentRuns.version} + 1` })
        .where(and(eq(agentRuns.id, call.runId), eq(agentRuns.status, 'waiting_for_approval')));
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId: call.runId,
        eventType: input.decision === 'approved' ? 'tool.approved' : 'tool.denied',
        payload: { toolCallId: input.toolCallId, approvalId: call.approvalId },
      });
      const resumeMessageId = this.createId();
      await enqueueOutboxMessage(transaction, {
        id: resumeMessageId,
        aggregateType: 'AgentRun',
        aggregateId: call.runId,
        topic: AGENT_RUN_COMMAND_TOPIC,
        messageKey: call.runId,
        payload: { command: 'run.execute', messageId: resumeMessageId, runId: call.runId },
        occurredAt: now,
        availableAt: new Date(now.getTime() + 31_000),
      });
      return { expired: false as const, event: toDurableEvent(event) };
    });
    await this.options.publisher.publish({ durable: true, event: persisted.event });
    if (persisted.expired) {
      throw new ToolCallApplicationError('approval_expired', 'Approval has expired');
    }
    return { toolCallId: input.toolCallId, decision: input.decision, status: input.decision };
  }

  public async execute(
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly toolCallId: string;
    readonly status: 'succeeded' | 'failed' | 'outcome_unknown';
    readonly output?: unknown;
  }> {
    const claimed = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${toolCalls} where id = ${toolCallId} for update`,
      );
      const rows = await transaction
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.id, toolCallId))
        .limit(1);
      const call = rows[0];
      if (!call) {
        throw new ToolCallApplicationError(
          'tool_call_not_found',
          `Tool Call ${toolCallId} not found`,
        );
      }
      const definition = this.options.registry.get(call.toolId, call.toolVersion);
      if (hashToolArguments(call.arguments) !== call.argumentsHash) {
        throw new ToolCallApplicationError(
          'approval_mismatch',
          'Stored Tool Call arguments were altered',
        );
      }
      if (call.idempotencyKey && call.status === 'succeeded') {
        return {
          replay: {
            toolCallId: call.id,
            status: call.status,
            output: call.output,
          },
        };
      }
      const allowed =
        call.status === 'approved' ||
        (call.status === 'proposed' && !APPROVAL_RISKS.has(call.risk));
      if (!allowed) {
        throw new ToolCallApplicationError('invalid_tool_state', `Tool Call is ${call.status}`);
      }
      const updated = await transaction
        .update(toolCalls)
        .set({ status: 'executing', updatedAt: this.now(), version: sql`${toolCalls.version} + 1` })
        .where(
          and(eq(toolCalls.id, toolCallId), inArray(toolCalls.status, ['proposed', 'approved'])),
        )
        .returning({ id: toolCalls.id });
      if (updated.length !== 1) {
        throw new ToolCallApplicationError(
          'invalid_tool_state',
          'Tool Call was claimed concurrently',
        );
      }
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId: call.runId,
        eventType: 'tool.executing',
        payload: { toolCallId, toolId: call.toolId, argumentsHash: call.argumentsHash },
      });
      return { call, definition, event: toDurableEvent(event) };
    });
    if ('replay' in claimed) return claimed.replay;
    await this.options.publisher.publish({ durable: true, event: claimed.event });

    let output: unknown;
    let failure: unknown;
    let status: 'succeeded' | 'failed' | 'outcome_unknown';
    try {
      output = await this.options.registry.execute(claimed.definition, claimed.call.arguments, {
        runId: claimed.call.runId,
        ...(claimed.call.taskId ? { taskId: claimed.call.taskId } : {}),
        toolCallId,
        ...(claimed.call.idempotencyKey ? { idempotencyKey: claimed.call.idempotencyKey } : {}),
        ...(signal ? { signal } : {}),
      });
      status = 'succeeded';
    } catch (error) {
      failure = { message: error instanceof Error ? error.message : 'Unknown tool error' };
      status =
        error instanceof ToolExecutionError && error.outcome === 'known_failed'
          ? 'failed'
          : APPROVAL_RISKS.has(claimed.call.risk)
            ? 'outcome_unknown'
            : 'failed';
    }
    const settled = await this.options.database.transaction(async (transaction) => {
      const now = this.now();
      const updated = await transaction
        .update(toolCalls)
        .set({
          status,
          ...(status === 'succeeded'
            ? { output }
            : { failure: failure as Readonly<Record<string, unknown>> }),
          settledAt: now,
          updatedAt: now,
          version: sql`${toolCalls.version} + 1`,
        })
        .where(and(eq(toolCalls.id, toolCallId), eq(toolCalls.status, 'executing')))
        .returning({ status: toolCalls.status, output: toolCalls.output });
      if (updated.length !== 1) {
        const currentRows = await transaction
          .select({ status: toolCalls.status, output: toolCalls.output })
          .from(toolCalls)
          .where(eq(toolCalls.id, toolCallId))
          .limit(1);
        const current = currentRows[0];
        if (!current) {
          throw new ToolCallApplicationError(
            'tool_call_not_found',
            `Tool Call ${toolCallId} disappeared during settlement`,
          );
        }
        if (
          current.status !== 'succeeded' &&
          current.status !== 'failed' &&
          current.status !== 'outcome_unknown'
        ) {
          throw new ToolCallApplicationError(
            'invalid_tool_state',
            `Tool Call settlement was fenced by ${current.status}`,
          );
        }
        return {
          events: [] as DurableRunEvent[],
          result: {
            toolCallId,
            status: current.status,
            ...(current.status === 'succeeded' ? { output: current.output } : {}),
          },
        };
      }
      await appendCheckpoint(transaction, {
        id: this.createId(),
        runId: claimed.call.runId,
        reason: 'tool_settled',
        state: { toolCallId, status },
      });
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId: claimed.call.runId,
        eventType: `tool.${status}`,
        payload: { toolCallId, ...(status === 'succeeded' ? { output } : { failure }) },
      });
      const events = [toDurableEvent(event)];
      const articleProposal = articleEditProposalOutput(output);
      if (status === 'succeeded' && articleProposal) {
        const created = await appendRunEvent(transaction, {
          id: this.createId(),
          runId: claimed.call.runId,
          eventType: 'article.proposal.created',
          payload: articleProposal,
        });
        events.push(toDurableEvent(created));
      }
      return {
        events,
        result: { toolCallId, status, ...(status === 'succeeded' ? { output } : {}) },
      };
    });
    for (const event of settled.events) {
      await this.options.publisher.publish({ durable: true, event });
    }
    return settled.result;
  }

  public async waitUntilExecutable(
    toolCallId: string,
    signal?: AbortSignal,
    pollIntervalMs = 200,
  ): Promise<'approved' | 'denied' | 'expired'> {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 25 || pollIntervalMs > 5_000) {
      throw new RangeError('Tool approval poll interval must be between 25 and 5000 ms');
    }
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('Tool approval wait was aborted');
      const rows = await this.options.database
        .select({ status: toolCalls.status, expiresAt: approvals.expiresAt })
        .from(toolCalls)
        .leftJoin(approvals, eq(approvals.toolCallId, toolCalls.id))
        .where(eq(toolCalls.id, toolCallId))
        .limit(1);
      const call = rows[0];
      if (!call) {
        throw new ToolCallApplicationError(
          'tool_call_not_found',
          `Tool Call ${toolCallId} not found`,
        );
      }
      if (call.status === 'approved' || call.status === 'proposed') return 'approved';
      if (call.status === 'denied') return 'denied';
      if (call.status === 'expired') return 'expired';
      if (call.status !== 'awaiting_approval') {
        throw new ToolCallApplicationError('invalid_tool_state', `Tool Call is ${call.status}`);
      }
      if (call.expiresAt && call.expiresAt.getTime() <= this.now().getTime()) {
        await this.expirePendingApproval(toolCallId);
        return 'expired';
      }
      await abortableDelay(pollIntervalMs, signal);
    }
  }

  private async expirePendingApproval(toolCallId: string): Promise<void> {
    const persisted = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${toolCalls} where id = ${toolCallId} for update`,
      );
      const rows = await transaction
        .select({ runId: toolCalls.runId, status: toolCalls.status, approvalId: approvals.id })
        .from(toolCalls)
        .innerJoin(approvals, eq(approvals.toolCallId, toolCalls.id))
        .where(eq(toolCalls.id, toolCallId))
        .limit(1);
      const call = rows[0];
      if (call?.status !== 'awaiting_approval') return undefined;
      const now = this.now();
      await transaction
        .update(approvals)
        .set({ decision: 'expired', decidedAt: now })
        .where(eq(approvals.id, call.approvalId));
      await transaction
        .update(toolCalls)
        .set({
          status: 'expired',
          settledAt: now,
          updatedAt: now,
          version: sql`${toolCalls.version} + 1`,
        })
        .where(eq(toolCalls.id, toolCallId));
      await transaction
        .update(agentRuns)
        .set({ status: 'running', updatedAt: now, version: sql`${agentRuns.version} + 1` })
        .where(and(eq(agentRuns.id, call.runId), eq(agentRuns.status, 'waiting_for_approval')));
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId: call.runId,
        eventType: 'tool.expired',
        payload: { toolCallId, approvalId: call.approvalId },
      });
      return toDurableEvent(event);
    });
    if (persisted) await this.options.publisher.publish({ durable: true, event: persisted });
  }
}

function articleEditProposalOutput(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const output = value as Readonly<Record<string, unknown>>;
  return output.kind === 'article_edit_proposal' && typeof output.proposalId === 'string'
    ? output
    : undefined;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError(signal.reason));
      },
      { once: true },
    );
  });
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Operation aborted', { cause: reason });
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

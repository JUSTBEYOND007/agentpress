// Recovery behavior adapted from Oh My Pi v17.1.8, commit f446b8a (MIT).
// Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Boluk.
import { randomUUID } from 'node:crypto';

import {
  agentRuns,
  agentTasks,
  appendCheckpoint,
  appendRunEvent,
  approvals,
  toolCalls,
} from '@agentpress/database';
import { hashToolArguments, summarizeToolArguments } from '@agentpress/tool-runtime';
import { and, eq, sql } from 'drizzle-orm';

import {
  APPROVAL_RISKS,
  ToolCallApplicationError,
  transportProvenanceMatches,
  type DecideToolCallApprovalInput,
  type ProposeToolCallInput,
  type ToolCallServiceOptions,
} from './tool-call-contracts.js';
import { ToolCallExecutionService } from './tool-call-execution-service.js';

export {
  ToolCallApplicationError,
  type DecideToolCallApprovalInput,
  type ProposeToolCallInput,
  type ToolCallServiceOptions,
} from './tool-call-contracts.js';

export class ToolCallService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly approvalTtlMs: number;
  private readonly execution: ToolCallExecutionService;

  public constructor(private readonly options: ToolCallServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.approvalTtlMs = options.approvalTtlMs ?? 15 * 60_000;
    this.execution = new ToolCallExecutionService(options);
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
    const argumentSummary = summarizeToolArguments(definition.inputSchema, input.arguments);
    const toolCallId = this.createId();
    const requiresApproval = APPROVAL_RISKS.has(definition.risk);
    const approvalId = requiresApproval ? this.createId() : undefined;
    const now = this.now();
    const status = requiresApproval ? ('awaiting_approval' as const) : ('proposed' as const);
    const persisted = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${agentRuns} where id = ${input.runId} for update`,
      );
      const runRows = await transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, input.runId))
        .limit(1);
      if (!runRows[0]) {
        throw new ToolCallApplicationError('run_not_found', `Agent Run ${input.runId} not found`);
      }
      if (
        !['planning', 'running', 'waiting_for_approval', 'recovering'].includes(runRows[0].status)
      ) {
        throw new ToolCallApplicationError(
          'invalid_tool_state',
          `Agent Run is ${runRows[0].status}`,
        );
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
            !transportProvenanceMatches(existing.transportProvenance, definition.transport) ||
            existing.evidenceProviderRevision !== (definition.evidence?.providerRevision ?? null) ||
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
        ...(definition.transport ? { transportProvenance: definition.transport } : {}),
        ...(definition.evidence
          ? { evidenceProviderRevision: definition.evidence.providerRevision }
          : {}),
        arguments: input.arguments,
        argumentSummary,
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
          ...(definition.transport ? { transportProvenance: definition.transport } : {}),
          ...(definition.evidence
            ? { evidenceProviderRevision: definition.evidence.providerRevision }
            : {}),
          argumentSummary,
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

  public decideApproval(input: DecideToolCallApprovalInput) {
    return this.execution.decideApproval(input);
  }

  public execute(toolCallId: string, signal?: AbortSignal) {
    return this.execution.execute(toolCallId, signal);
  }

  public waitUntilExecutable(toolCallId: string, signal?: AbortSignal, pollIntervalMs = 200) {
    return this.execution.waitUntilExecutable(toolCallId, signal, pollIntervalMs);
  }
}

function toDurableEvent(event: {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}) {
  return { ...event };
}

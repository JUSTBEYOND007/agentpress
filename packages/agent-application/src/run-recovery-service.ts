import {
  agentRuns,
  agentTasks,
  appendCheckpoint,
  appendRunEvent,
  cancelAgentRunTasks,
  type AgentPressDatabase,
  runToolChoices,
  toolCalls,
} from '@agentpress/database';
import { decideToolReplay, resolveToolReplaySafety } from '@agentpress/tool-runtime';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type {
  DurableRunEvent,
  RequestRunCancellationResult,
  RunEventPublisher,
} from './contracts.js';
import { isTerminalRunStatus, toDurableEvent } from './run-projection-service.js';

type RunRecoveryServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly publisher: RunEventPublisher;
  readonly createId: () => string;
  readonly now: () => Date;
};

export class RunRecoveryService {
  public constructor(private readonly options: RunRecoveryServiceOptions) {}

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
          updatedAt: this.options.now(),
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
      const now = this.options.now();
      const cancelledTasks = await cancelAgentRunTasks(transaction, { runId, now });
      const taskEvents: DurableRunEvent[] = [];
      for (const task of cancelledTasks) {
        const taskEvent = await appendRunEvent(transaction, {
          id: this.options.createId(),
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
        id: this.options.createId(),
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

  public async prepare(runId: string): Promise<boolean> {
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
      const now = this.options.now();
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
            id: this.options.createId(),
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
          id: this.options.createId(),
          runId,
          eventType: `tool.${status}`,
          payload: { toolCallId: call.id, reason: 'worker_lease_lost', action, safety },
        });
        events.push(toDurableEvent(toolEvent));
      }
      const interruptedTasks = await transaction
        .update(agentTasks)
        .set({ status: 'interrupted', updatedAt: now, version: sql`${agentTasks.version} + 1` })
        .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, 'running')))
        .returning({ taskId: agentTasks.id, attempt: agentTasks.attempt });
      for (const task of interruptedTasks) {
        const taskEvent = await appendRunEvent(transaction, {
          id: this.options.createId(),
          runId,
          eventType: 'task.interrupted',
          payload: {
            taskId: task.taskId,
            attempt: task.attempt,
            reason: 'worker_lease_lost',
          },
        });
        events.push(toDurableEvent(taskEvent));
      }
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
        id: this.options.createId(),
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
        id: this.options.createId(),
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
}

function isRecoverableRunStatus(status: string): status is 'planning' | 'running' | 'interrupted' {
  return status === 'planning' || status === 'running' || status === 'interrupted';
}

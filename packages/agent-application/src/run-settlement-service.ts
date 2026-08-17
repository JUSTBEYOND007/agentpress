import type {
  RuntimeAssistantMessage,
  RuntimeMessage,
  RuntimeResult,
  RuntimeUsage,
} from '@agentpress/agent-runtime';
import {
  agentRuns,
  agentTasks,
  appendCheckpoint,
  appendRunEvent,
  cancelAgentRunTasks,
  type AgentPressDatabase,
  conversationBranches,
  conversationMessages,
  isDatabaseConnectionFailure,
  queuedFollowups,
  runDirectives,
  runEvents,
  runToolChoices,
  taskResults,
} from '@agentpress/database';
import { and, asc, eq, gt, inArray, max, sql } from 'drizzle-orm';

import {
  StaleWorkerSettlementError,
  type DurableRunEvent,
  type ExecuteDirectRunResult,
  type RunEventPublisher,
} from './contracts.js';
import { encodeRuntimeMessage } from './runtime-message-codec.js';
import { toDurableEvent } from './run-projection-service.js';
import { classifyTerminalOutcome } from './terminal-outcome-policy.js';
import {
  addRuntimeUsage,
  aggregateAssistantUsage,
  emptyUsage,
  persistedRuntimeUsage,
} from './planned-run-results.js';

type CompactionResult =
  | { readonly status: 'not_needed' }
  | {
      readonly status: 'completed' | 'failed';
      readonly compactionId: string;
      readonly version: number;
    };

type RunSettlementServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly publisher: RunEventPublisher;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly compactConversation: (branchId: string) => Promise<CompactionResult>;
  readonly activateNextFollowUp: (branchId: string) => Promise<void>;
};

export class RunSettlementService {
  public constructor(private readonly options: RunSettlementServiceOptions) {}

  public async settle(
    branchId: string,
    runId: string,
    result: RuntimeResult,
    completedWithDegradation = false,
    failureStage?: 'synthesis',
  ): Promise<ExecuteDirectRunResult> {
    const terminalOutcome = classifyTerminalOutcome(result);
    const eventSequenceBeforeSettlement = await this.latestEventSequence(runId);
    let durableEvents: DurableRunEvent[];
    try {
      durableEvents = await this.options.database.transaction(async (transaction) => {
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
        const now = this.options.now();
        const events: DurableRunEvent[] = [];
        const aggregateSettledRunUsage = async (
          terminalUsage?: RuntimeUsage,
        ): Promise<RuntimeUsage> => {
          const rows = await transaction
            .select({ usage: taskResults.usage })
            .from(taskResults)
            .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
            .where(eq(agentTasks.runId, runId));
          return rows
            .map(({ usage }) => persistedRuntimeUsage(usage))
            .filter((usage): usage is RuntimeUsage => usage !== undefined)
            .reduce(addRuntimeUsage, terminalUsage ?? emptyUsage);
        };

        if (currentStatus === 'recovering' || currentStatus === 'interrupted') {
          throw new StaleWorkerSettlementError(runId);
        }

        if (terminalOutcome === 'completed' && currentStatus === 'running') {
          const assistant = findLastAssistantMessage(result.messages);
          if (!assistant) {
            throw new Error(`Pi completed Agent Run ${runId} without a stable assistant message`);
          }
          const runUsage = await aggregateSettledRunUsage(assistant.usage);
          const sequenceRows = await transaction
            .select({ sequence: max(conversationMessages.sequence) })
            .from(conversationMessages)
            .where(eq(conversationMessages.branchId, branchId));
          await transaction.insert(conversationMessages).values({
            id: this.options.createId(),
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
            .set({ status: 'cancelled', rejectionReason: 'run_settled', settledAt: now })
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
              finalOutcome: { usage: runUsage },
              completedAt: now,
              updatedAt: now,
              version: sql`${agentRuns.version} + 1`,
            })
            .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')));
          await appendCheckpoint(transaction, {
            id: this.options.createId(),
            runId,
            reason: 'run_settled',
            state: {
              status: completedWithDegradation ? 'completed_with_degradation' : 'completed',
              stableAssistantMessage: assistant,
            },
          });
          const messageEvent = await appendRunEvent(transaction, {
            id: this.options.createId(),
            runId,
            eventType: 'message.completed',
            payload: { message: assistant },
          });
          events.push(toDurableEvent(messageEvent));
          const completedEvent = await appendRunEvent(transaction, {
            id: this.options.createId(),
            runId,
            eventType: completedWithDegradation
              ? 'run.completed_with_degradation'
              : 'run.completed',
            payload: { usage: runUsage, degraded: completedWithDegradation },
          });
          events.push(toDurableEvent(completedEvent));
          return events;
        }

        if (terminalOutcome === 'cancelled' || currentStatus === 'cancelling') {
          const cancelledTasks = await cancelAgentRunTasks(transaction, { runId, now });
          for (const task of cancelledTasks) {
            const taskEvent = await appendRunEvent(transaction, {
              id: this.options.createId(),
              runId,
              eventType: 'task.cancelled',
              payload: { taskId: task.taskId, attempt: task.attempt, reason: 'run_cancelled' },
            });
            events.push(toDurableEvent(taskEvent));
          }
          await transaction
            .update(runToolChoices)
            .set({ status: 'cancelled', rejectionReason: 'cancelled', settledAt: now })
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
            id: this.options.createId(),
            runId,
            reason: 'run_settled',
            state: { status: 'cancelled' },
          });
          const event = await appendRunEvent(transaction, {
            id: this.options.createId(),
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

        const failedRunUsage = await aggregateSettledRunUsage(
          aggregateAssistantUsage(result.messages),
        );

        await transaction
          .update(runToolChoices)
          .set({ status: 'cancelled', rejectionReason: 'run_failed', settledAt: now })
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
            finalOutcome: { error: result.error, usage: failedRunUsage },
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
          id: this.options.createId(),
          runId,
          reason: 'run_settled',
          state: { status: 'failed', error: result.error },
        });
        if (failureStage === 'synthesis') {
          const synthesisEvent = await appendRunEvent(transaction, {
            id: this.options.createId(),
            runId,
            eventType: 'synthesis.failed',
            payload: {
              code: 'synthesis_failed',
              causeCode: result.error.code,
              messageKey: 'synthesis.failed',
              retryable: result.error.retryable,
            },
          });
          events.push(toDurableEvent(synthesisEvent));
        }
        const event = await appendRunEvent(transaction, {
          id: this.options.createId(),
          runId,
          eventType: 'run.failed',
          payload: {
            error: result.error,
            ...(failureStage ? { failureStage } : {}),
          },
        });
        events.push(toDurableEvent(event));
        return events;
      });
    } catch (error) {
      if (!isDatabaseConnectionFailure(error)) throw error;
      let reconciled: DurableRunEvent[] | undefined;
      try {
        reconciled = await this.reconcileCommittedSettlement(runId, eventSequenceBeforeSettlement);
      } catch {
        throw error;
      }
      if (!reconciled) throw error;
      durableEvents = reconciled;
    }

    const terminal = durableEvents.at(-1)?.eventType;
    const compactionEvent =
      terminal === 'run.cancelled' ? undefined : await this.compactAfterSettlement(branchId, runId);
    if (terminal !== 'run.cancelled') await this.options.activateNextFollowUp(branchId);
    for (const event of durableEvents) {
      await this.options.publisher.publish({ durable: true, event });
    }
    if (compactionEvent) {
      await this.options.publisher.publish({ durable: true, event: compactionEvent });
    }
    return {
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
  }

  private async latestEventSequence(runId: string): Promise<number> {
    const rows = await this.options.database
      .select({ sequence: max(runEvents.sequence) })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));
    return rows[0]?.sequence ?? 0;
  }

  private async reconcileCommittedSettlement(
    runId: string,
    afterSequence: number,
  ): Promise<DurableRunEvent[] | undefined> {
    const [runRows, eventRows] = await Promise.all([
      this.options.database
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1),
      this.options.database
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.sequence, afterSequence)))
        .orderBy(asc(runEvents.sequence)),
    ]);
    const status = runRows[0]?.status;
    const terminalEventType = status ? terminalEventForStatus(status) : undefined;
    if (!terminalEventType) return undefined;
    const terminal = eventRows.findLast(({ eventType }) => eventType === terminalEventType);
    if (!terminal) return undefined;
    return eventRows
      .filter(({ sequence }) => sequence <= terminal.sequence)
      .map((event) => toDurableEvent(event));
  }

  private async compactAfterSettlement(
    branchId: string,
    runId: string,
  ): Promise<DurableRunEvent | undefined> {
    try {
      const result = await this.options.compactConversation(branchId);
      if (result.status === 'not_needed') return undefined;
      const persisted = await this.options.database.transaction((transaction) =>
        appendRunEvent(transaction, {
          id: this.options.createId(),
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
          id: this.options.createId(),
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
}

function terminalEventForStatus(status: string): string | undefined {
  if (status === 'completed') return 'run.completed';
  if (status === 'completed_with_degradation') return 'run.completed_with_degradation';
  if (status === 'cancelled') return 'run.cancelled';
  if (status === 'failed') return 'run.failed';
  return undefined;
}

function findLastAssistantMessage(
  messages: readonly RuntimeMessage[],
): RuntimeAssistantMessage | undefined {
  return messages.findLast(
    (message): message is RuntimeAssistantMessage => message.role === 'assistant',
  );
}

import {
  agentRuns,
  agentTasks,
  appendRunEvent,
  runEvents,
  taskResultInvalidations,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DurableRunEvent, RunEventPublisher } from './contracts.js';
import { inspectRecoveryFacts } from './recovery-fact-inspector.js';
import {
  recoverSettlement,
  type RecoveryGap,
  type RecoveryNextAction,
  type RecoveryPreservedFacts,
} from './recovery-policy.js';
import { toDurableEvent } from './run-projection-service.js';

type RecoveryFactValidationServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly publisher: RunEventPublisher;
  readonly createId: () => string;
  readonly now: () => Date;
};

export type RecoveryFactValidationResult =
  | { readonly status: 'not_applicable' | 'already_validated' }
  | { readonly status: 'validated' }
  | {
      readonly status: 'completed_with_degradation';
      readonly preservedFacts: readonly RecoveryPreservedFacts[];
      readonly missingFacts: readonly RecoveryGap[];
      readonly unverified: readonly RecoveryGap[];
      readonly nextActions: readonly RecoveryNextAction[];
    };

/** Owns recovery invalidation and projection; fact inspection remains independent. */
export class RecoveryFactValidationService {
  public constructor(private readonly options: RecoveryFactValidationServiceOptions) {}

  public async invalidateDamagedTaskResults(runId: string): Promise<number> {
    const persisted = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from ${agentRuns} where id = ${runId} for update`);
      const runRows = await transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      if (runRows[0]?.status !== 'recovering') return { count: 0, events: [] };
      const inspection = await inspectRecoveryFacts(transaction, runId);
      const events: DurableRunEvent[] = [];
      for (const damaged of inspection.damagedTaskResults) {
        if (damaged.attempt >= damaged.maxAttempts) continue;
        const interrupted = await transaction
          .update(agentTasks)
          .set({
            status: 'interrupted',
            completedAt: null,
            updatedAt: this.options.now(),
            version: sql`${agentTasks.version} + 1`,
          })
          .where(
            and(
              eq(agentTasks.id, damaged.taskId),
              eq(agentTasks.runId, runId),
              eq(agentTasks.status, 'succeeded'),
              eq(agentTasks.attempt, damaged.attempt),
            ),
          )
          .returning({ id: agentTasks.id });
        if (interrupted.length === 0) continue;
        await transaction.insert(taskResultInvalidations).values({
          id: this.options.createId(),
          taskResultId: damaged.taskResultId,
          taskId: damaged.taskId,
          runId,
          reason: 'recovery_validation_failed',
          issues: damaged.issues.map(({ code, message }) => ({ code, message })),
        });
        const event = await appendRunEvent(transaction, {
          id: this.options.createId(),
          runId,
          eventType: 'task.interrupted',
          payload: {
            taskId: damaged.taskId,
            attempt: damaged.attempt,
            reason: 'recovery_validation_failed',
            artifactVersionIds: damaged.artifactVersionIds,
            issueCodes: [...new Set(damaged.issues.map(({ code }) => code))],
          },
        });
        events.push(toDurableEvent(event));
      }
      return { count: events.length, events };
    });
    for (const event of persisted.events) {
      await this.options.publisher.publish({ durable: true, event });
    }
    return persisted.count;
  }

  public async validateAndProject(runId: string): Promise<RecoveryFactValidationResult> {
    const persisted = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from ${agentRuns} where id = ${runId} for update`);
      const runRows = await transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      if (runRows[0]?.status !== 'running') {
        return { result: { status: 'not_applicable' as const } };
      }
      const recoveryEvents = await transaction
        .select({ eventType: runEvents.eventType })
        .from(runEvents)
        .where(
          and(
            eq(runEvents.runId, runId),
            inArray(runEvents.eventType, [
              'run.recovering',
              'run.recovery.validated',
              'run.recovery.degraded',
            ]),
          ),
        );
      if (!recoveryEvents.some(({ eventType }) => eventType === 'run.recovering')) {
        return { result: { status: 'not_applicable' as const } };
      }
      if (
        recoveryEvents.some(
          ({ eventType }) =>
            eventType === 'run.recovery.validated' || eventType === 'run.recovery.degraded',
        )
      ) {
        return { result: { status: 'already_validated' as const } };
      }
      const inspection = await inspectRecoveryFacts(transaction, runId);
      if (inspection.issues.length === 0) {
        const event = await appendRunEvent(transaction, {
          id: this.options.createId(),
          runId,
          eventType: 'run.recovery.validated',
          payload: { preservedFacts: inspection.preservedFacts },
        });
        return {
          result: { status: 'validated' as const },
          event: toDurableEvent(event),
        };
      }
      const recovery = await recoverSettlement({
        candidate: { artifactVersionIds: inspection.artifactVersionIds },
        initialValidation: { valid: false, issues: inspection.issues },
        replaySafe: false,
        preservedFacts: inspection.preservedFacts,
        missingFacts: inspection.missingFacts,
        nextActions: inspection.artifactVersionIds.map((targetId) => ({
          kind: 'regenerate_artifact' as const,
          labelKey: 'recovery.action.regenerate_artifact',
          targetId,
        })),
        settle: () => Promise.reject(new Error('Non-replay-safe recovery must not settle')),
        validate: () => Promise.reject(new Error('Non-replay-safe recovery must not validate')),
      });
      if (recovery.status !== 'completed_with_degradation') {
        throw new Error('Recovery fact validation produced an invalid terminal status');
      }
      const event = await appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: 'run.recovery.degraded',
        payload: {
          preservedFacts: recovery.preservedFacts,
          missingFacts: recovery.missingFacts,
          unverified: recovery.unverified,
          nextActions: recovery.nextActions,
        },
      });
      return {
        result: {
          status: recovery.status,
          preservedFacts: recovery.preservedFacts,
          missingFacts: recovery.missingFacts,
          unverified: recovery.unverified,
          nextActions: recovery.nextActions,
        },
        event: toDurableEvent(event),
      };
    });
    if (persisted.event) {
      await this.options.publisher.publish({ durable: true, event: persisted.event });
    }
    return persisted.result;
  }
}

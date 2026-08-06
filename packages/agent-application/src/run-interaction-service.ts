import {
  agentRuns,
  appendCheckpoint,
  appendRunEvent,
  enqueueOutboxMessage,
  type AgentPressDatabase,
  queuedFollowups,
  rootRequests,
  runDirectives,
  runQuestions,
} from '@agentpress/database';
import { and, eq, max, sql } from 'drizzle-orm';

import {
  AGENT_RUN_COMMAND_TOPIC,
  AgentApplicationError,
  type EnqueueRunDirectiveResult,
  type RunEventPublisher,
} from './contracts.js';
import { isTerminalRunStatus, toDurableEvent } from './run-projection-service.js';

type RunInteractionServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly publisher: RunEventPublisher;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly steerActiveMain: (runId: string, content: string) => boolean;
};

export class RunInteractionService {
  public constructor(private readonly options: RunInteractionServiceOptions) {}

  public async enqueueSteering(
    runId: string,
    rawContent: string,
  ): Promise<EnqueueRunDirectiveResult> {
    const content = validateContent(
      rawContent,
      'Directive must contain between 1 and 100000 characters',
    );
    const persisted = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from ${agentRuns} where id = ${runId} for update`);
      const rows = await transaction
        .select({ status: agentRuns.status })
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
      const directiveId = this.options.createId();
      await transaction.insert(runDirectives).values({
        id: directiveId,
        runId,
        sequence,
        kind: 'steering',
        content,
      });
      const event = await appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: 'steering.queued',
        payload: { directiveId, sequence },
      });
      return {
        result: {
          directiveId,
          runId,
          kind: 'steering' as const,
          sequence,
          status: 'pending' as const,
        },
        event: toDurableEvent(event),
      };
    });
    await this.options.publisher.publish({ durable: true, event: persisted.event });
    return persisted.result;
  }

  public async steerActiveMain(
    runId: string,
    directiveId: string,
    content: string,
  ): Promise<boolean> {
    if (!this.options.steerActiveMain(runId, content)) return false;
    const event = await this.options.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(runDirectives)
        .set({ status: 'applied', appliedAt: this.options.now() })
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
        id: this.options.createId(),
        runId,
        reason: 'steering_applied',
        state: { directiveId, delivery: 'active_main' },
      });
      return appendRunEvent(transaction, {
        id: this.options.createId(),
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

  public async enqueueFollowUp(
    runId: string,
    rawContent: string,
  ): Promise<EnqueueRunDirectiveResult> {
    const content = validateContent(
      rawContent,
      'Follow-up must contain between 1 and 100000 characters',
    );
    const persisted = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from ${agentRuns} where id = ${runId} for update`);
      const rows = await transaction
        .select({ status: agentRuns.status, userId: rootRequests.requestedByUserId })
        .from(agentRuns)
        .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const run = rows[0];
      if (!run) {
        throw new AgentApplicationError('run_not_found', `Agent Run ${runId} does not exist`);
      }
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
      const followUpId = this.options.createId();
      await transaction.insert(queuedFollowups).values({
        id: followUpId,
        runId,
        sequence,
        content,
        requestedByUserId: run.userId,
      });
      const event = await appendRunEvent(transaction, {
        id: this.options.createId(),
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
        id: this.options.createId(),
        runId,
        eventType: 'steering.cancelled',
        payload: { directiveId },
      });
    });
    if (event) {
      await this.options.publisher.publish({ durable: true, event: toDurableEvent(event) });
    }
    return Boolean(event);
  }

  public async answerQuestion(runId: string, questionId: string, answer: string, userId: string) {
    const value = validateContent(answer, 'Answer must contain 1-100000 characters');
    const persisted = await this.options.database.transaction(async (transaction) => {
      const now = this.options.now();
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
      if (rows.length === 0) {
        throw new AgentApplicationError('invalid_directive', 'Question is no longer pending');
      }
      await transaction
        .update(agentRuns)
        .set({ status: 'recovering', updatedAt: now, version: sql`${agentRuns.version} + 1` })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'waiting_for_user')));
      const event = await appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: 'user.input_received',
        payload: { questionId },
      });
      const outboxId = this.options.createId();
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
}

function validateContent(rawContent: string, errorMessage: string): string {
  const content = rawContent.trim();
  if (content.length === 0 || content.length > 100_000) {
    throw new AgentApplicationError('invalid_directive', errorMessage);
  }
  return content;
}

import { randomUUID } from 'node:crypto';

import type {
  RuntimeAssistantMessage,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeResult,
} from '@agentpress/agent-runtime';
import {
  agentRuns,
  appendRunEvent,
  type AgentPressDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  enqueueOutboxMessage,
  rootRequests,
  runEvents,
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
  type RequestRunCancellationResult,
  type RunEventPublisher,
} from './contracts.js';

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
  readonly now?: () => Date;
  readonly createId?: () => string;
};

export class DirectRunService {
  private readonly now: () => Date;
  private readonly createId: () => string;

  public constructor(private readonly options: DirectRunServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
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
        idempotencyKey: input.idempotencyKey,
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
      const queued = await appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.queued',
        payload: { mode: 'direct', rootRequestId },
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
    if (context.status !== 'queued') {
      return { runId, status: 'ignored' };
    }

    const started = await this.options.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(agentRuns)
        .set({ status: 'running', updatedAt: this.now(), version: sql`${agentRuns.version} + 1` })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'queued')))
        .returning({ id: agentRuns.id });
      if (updated.length === 0) {
        return undefined;
      }
      return appendRunEvent(transaction, {
        id: this.createId(),
        runId,
        eventType: 'run.started',
        payload: { mode: 'direct' },
      });
    });
    if (!started) {
      return { runId, status: 'ignored' };
    }
    await this.options.publisher.publish({ durable: true, event: toDurableEvent(started) });

    let result: RuntimeResult;
    try {
      const runtime = this.options.runtimeFactory.create();
      result = await runtime.execute(
        {
          runId,
          systemPrompt: this.options.systemPrompt,
          history: context.history,
          prompt: context.prompt,
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
      }
    | undefined
  > {
    const runRows = await this.options.database
      .select({
        branchId: agentRuns.branchId,
        status: agentRuns.status,
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

    return {
      branchId: run.branchId,
      prompt: rootMessage.content,
      history,
      status: run.status,
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

  private async settleRun(
    branchId: string,
    runId: string,
    result: RuntimeResult,
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
            status: 'completed',
            finalOutcome: { usage: assistant.usage },
            completedAt: now,
            updatedAt: now,
            version: sql`${agentRuns.version} + 1`,
          })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')));
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
          eventType: 'run.completed',
          payload: { usage: assistant.usage },
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
    return {
      runId,
      status:
        terminal === 'run.completed'
          ? 'completed'
          : terminal === 'run.cancelled'
            ? 'cancelled'
            : 'failed',
    };
  }
}

function encodeRuntimeMessage(message: RuntimeMessage): readonly unknown[] {
  return [{ type: 'agentpress.runtime-message', version: 1, message }];
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

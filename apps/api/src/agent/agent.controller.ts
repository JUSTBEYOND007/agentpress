import {
  AgentApplicationError,
  DirectRunService,
  ToolCallApplicationError,
  ToolCallService,
  type DurableRunEvent,
  type LiveRunEvent,
} from '@agentpress/agent-application';
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Optional,
  Param,
  Post,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';

import { RedisRunEventBus } from './redis-run-event-bus.js';

type CreateRunBody = {
  readonly branchId?: unknown;
  readonly prompt?: unknown;
};

type RunDirectiveBody = {
  readonly content?: unknown;
};

type ToolApprovalBody = {
  readonly decision?: unknown;
  readonly userId?: unknown;
};

class StreamConnectionState {
  private closed = false;

  public close(): void {
    this.closed = true;
  }

  public isClosed(): boolean {
    return this.closed;
  }
}

@Controller()
export class AgentController {
  public constructor(
    private readonly runs: DirectRunService,
    private readonly eventBus: RedisRunEventBus,
    @Optional() private readonly toolCalls?: ToolCallService,
  ) {}

  @Post('conversations/:conversationId/runs')
  @HttpCode(202)
  public async createRun(
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateRunBody,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 160) {
      throw new BadRequestException('A valid Idempotency-Key header is required');
    }
    if (typeof body.branchId !== 'string' || typeof body.prompt !== 'string') {
      throw new BadRequestException('branchId and prompt must be strings');
    }

    try {
      return await this.runs.create({
        conversationId,
        branchId: body.branchId,
        prompt: body.prompt,
        idempotencyKey,
      });
    } catch (error) {
      throw mapApplicationError(error);
    }
  }

  @Sse('runs/:runId/events')
  public streamEvents(
    @Param('runId') runId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
  ): Observable<MessageEvent> {
    const afterSequence = parseLastEventId(lastEventId);

    return new Observable<MessageEvent>((subscriber) => {
      const connection = new StreamConnectionState();
      let replaying = true;
      let lastSequence = afterSequence;
      let unsubscribe: (() => Promise<void>) | undefined;
      const pending: LiveRunEvent[] = [];
      const heartbeat = setInterval(() => {
        subscriber.next({ type: 'heartbeat', data: { runId } });
      }, 15_000);
      const emit = (event: LiveRunEvent): void => {
        if (event.durable) {
          if (event.event.sequence <= lastSequence) {
            return;
          }
          lastSequence = event.event.sequence;
          subscriber.next(toSseEvent(event.event));
          return;
        }
        subscriber.next({
          type: event.event.type,
          data: { runId, ...event.event },
        });
      };
      const receive = (event: LiveRunEvent): void => {
        if (replaying) {
          pending.push(event);
        } else {
          emit(event);
        }
      };

      void (async () => {
        try {
          unsubscribe = await this.eventBus.subscribe(runId, receive);
          if (connection.isClosed()) {
            await unsubscribe();
            return;
          }
          const replay = await this.runs.listEvents(runId, afterSequence);
          for (const event of replay) {
            emit({ durable: true, event });
          }
          replaying = false;
          for (const event of pending) {
            emit(event);
          }
          pending.length = 0;
        } catch (error) {
          subscriber.error(error);
        }
      })();

      return () => {
        connection.close();
        clearInterval(heartbeat);
        if (unsubscribe) {
          void unsubscribe();
        }
      };
    });
  }

  @Post('runs/:runId/cancel')
  @HttpCode(202)
  public async cancelRun(@Param('runId') runId: string) {
    const result = await this.runs.requestCancellation(runId);
    if (result.outcome === 'not_found') {
      throw new NotFoundException(`Agent Run ${runId} does not exist`);
    }
    if (result.outcome === 'accepted') {
      await this.eventBus.publishCancellation(runId);
    }
    return result;
  }

  @Post('runs/:runId/steering')
  @HttpCode(202)
  public async steerRun(@Param('runId') runId: string, @Body() body: RunDirectiveBody) {
    if (typeof body.content !== 'string') {
      throw new BadRequestException('content must be a string');
    }
    try {
      return await this.runs.enqueueSteering(runId, body.content);
    } catch (error) {
      throw mapApplicationError(error);
    }
  }

  @Post('runs/:runId/follow-ups')
  @HttpCode(202)
  public async followUpRun(@Param('runId') runId: string, @Body() body: RunDirectiveBody) {
    if (typeof body.content !== 'string') {
      throw new BadRequestException('content must be a string');
    }
    try {
      return await this.runs.enqueueFollowUp(runId, body.content);
    } catch (error) {
      throw mapApplicationError(error);
    }
  }

  @Post('tool-calls/:toolCallId/approval')
  @HttpCode(202)
  public async decideToolCall(
    @Param('toolCallId') toolCallId: string,
    @Body() body: ToolApprovalBody,
  ) {
    if (!this.toolCalls) {
      throw new BadRequestException('Tool Call service is unavailable');
    }
    if (
      (body.decision !== 'approved' && body.decision !== 'denied') ||
      typeof body.userId !== 'string'
    ) {
      throw new BadRequestException('decision and userId are required');
    }
    try {
      return await this.toolCalls.decideApproval({
        toolCallId,
        decision: body.decision,
        userId: body.userId,
      });
    } catch (error) {
      throw mapApplicationError(error);
    }
  }
}

function parseLastEventId(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new BadRequestException('Last-Event-ID must be a non-negative integer');
  }
  return sequence;
}

function toSseEvent(event: DurableRunEvent): MessageEvent {
  return {
    id: String(event.sequence),
    type: event.eventType,
    data: {
      id: event.id,
      runId: event.runId,
      sequence: event.sequence,
      eventVersion: event.eventVersion,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    },
  };
}

function mapApplicationError(error: unknown): Error {
  if (!(error instanceof AgentApplicationError)) {
    if (error instanceof ToolCallApplicationError) {
      return error.code === 'run_not_found' || error.code === 'tool_call_not_found'
        ? new NotFoundException(error.message)
        : new BadRequestException(error.message);
    }
    return error instanceof Error ? error : new Error('Unknown Agent application error');
  }
  if (
    error.code === 'branch_not_found' ||
    error.code === 'conversation_not_found' ||
    error.code === 'run_not_found'
  ) {
    return new NotFoundException(error.message);
  }
  return new BadRequestException(error.message);
}

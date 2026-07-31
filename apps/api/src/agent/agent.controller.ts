import {
  AgentApplicationError,
  DirectRunService,
  ToolCallApplicationError,
  ToolCallService,
  type DurableRunEvent,
  type LiveRunEvent,
} from '@agentpress/agent-application';
import {
  conversationBranches,
  conversationMessages,
  conversations,
  type DatabaseConnection,
} from '@agentpress/database';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, lte } from 'drizzle-orm';
import { Observable } from 'rxjs';

import { RedisRunEventBus } from './redis-run-event-bus.js';
import { CurrentUser } from '../auth/current-user.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { AuthorizationService } from '../auth/authorization.service.js';
import { DATABASE_CONNECTION } from './agent.providers.js';

type CreateRunBody = {
  readonly branchId?: unknown;
  readonly prompt?: unknown;
  readonly mentionTargetIds?: unknown;
  readonly attachmentIds?: unknown;
  readonly skills?: unknown;
  readonly contextBindings?: unknown;
};

type RunDirectiveBody = {
  readonly content?: unknown;
  readonly answer?: unknown;
};

type ToolApprovalBody = {
  readonly decision?: unknown;
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
    @Inject(DirectRunService) private readonly runs: DirectRunService,
    @Inject(RedisRunEventBus) private readonly eventBus: RedisRunEventBus,
    @Inject(ToolCallService) @Optional() private readonly toolCalls?: ToolCallService,
    @Inject(AuthorizationService) private readonly authorization?: AuthorizationService,
    @Inject(DATABASE_CONNECTION) private readonly connection?: DatabaseConnection,
  ) {}

  @Get('conversations/:conversationId/branches/:branchId/messages')
  public async listMessages(
    @Param('conversationId') conversationId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.listMessages(conversationId, branchId, user.id);
  }

  @Post('conversations/:conversationId/branches/:branchId/fork')
  public async forkBranch(
    @Param('conversationId') conversationId: string,
    @Param('branchId') branchId: string,
    @Body() body: { readonly messageId?: unknown },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!this.connection) throw new BadRequestException('Database connection is unavailable');
    if (typeof body.messageId !== 'string')
      throw new BadRequestException('messageId must be a string');
    const messageId = body.messageId;
    const rows = await this.connection.db
      .select({
        workspaceId: conversations.workspaceId,
        sequence: conversationMessages.sequence,
      })
      .from(conversationMessages)
      .innerJoin(conversationBranches, eq(conversationBranches.id, conversationMessages.branchId))
      .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
      .where(
        and(
          eq(conversationMessages.id, messageId),
          eq(conversationMessages.branchId, branchId),
          eq(conversations.id, conversationId),
          eq(conversationMessages.stable, true),
        ),
      )
      .limit(1);
    const forkPoint = rows[0];
    if (!forkPoint) throw new NotFoundException('Fork message does not exist on this branch');
    await this.authorization?.assertWorkspaceMember(forkPoint.workspaceId, user.id);
    const messages = await this.connection.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.branchId, branchId),
          eq(conversationMessages.stable, true),
          lte(conversationMessages.sequence, forkPoint.sequence),
        ),
      )
      .orderBy(asc(conversationMessages.sequence));
    const newBranchId = randomUUID();
    await this.connection.db.transaction(async (transaction) => {
      await transaction.insert(conversationBranches).values({
        id: newBranchId,
        conversationId,
        parentBranchId: branchId,
        forkedFromMessageId: messageId,
      });
      if (messages.length > 0)
        await transaction.insert(conversationMessages).values(
          messages.map((message) => ({
            id: randomUUID(),
            branchId: newBranchId,
            role: message.role,
            sequence: message.sequence,
            content: message.content,
            stable: true,
            createdAt: message.createdAt,
          })),
        );
    });
    return { branchId: newBranchId, parentBranchId: branchId, forkedFromMessageId: messageId };
  }

  @Post('conversations/:conversationId/runs')
  @HttpCode(202)
  public async createRun(
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateRunBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 160) {
      throw new BadRequestException('A valid Idempotency-Key header is required');
    }
    if (typeof body.branchId !== 'string' || typeof body.prompt !== 'string') {
      throw new BadRequestException('branchId and prompt must be strings');
    }
    const mentionTargetIds = parseStringArray(body.mentionTargetIds, 'mentionTargetIds', 20);
    const attachmentIds = parseStringArray(body.attachmentIds, 'attachmentIds', 10);
    const skills = parseSkills(body.skills);
    const contextBindings = parseContextBindings(body.contextBindings);

    try {
      return await this.runs.create({
        conversationId,
        branchId: body.branchId,
        userId: user.id,
        prompt: body.prompt,
        idempotencyKey,
        mentionTargetIds,
        attachmentIds,
        skills,
        contextBindings,
      });
    } catch (error) {
      throw mapApplicationError(error);
    }
  }

  @Get('conversations/:conversationId/branches/:branchId/runs')
  public async listRuns(
    @Param('conversationId') conversationId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.listRuns(conversationId, branchId, user.id);
  }

  @Get('runs/:runId')
  public async getRun(@Param('runId') runId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.authorization?.assertRunAccess(runId, user.id);
    const projection = await this.runs.getProjection(runId);
    if (!projection) throw new NotFoundException(`Agent Run ${runId} does not exist`);
    return {
      runId: projection.runId,
      rootMessageId: projection.rootMessageId,
      status: projection.status,
      mode: projection.mode,
      ...(projection.activePlanRevision
        ? { activePlanRevision: projection.activePlanRevision }
        : {}),
      ...(projection.pendingInteraction
        ? { pendingInteraction: projection.pendingInteraction }
        : {}),
      lastEventId: projection.lastEventId,
      createdAt: projection.createdAt,
      ...(projection.completedAt ? { completedAt: projection.completedAt } : {}),
    };
  }

  @Get('runs/:runId/projection')
  public async getProjection(
    @Param('runId') runId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization?.assertRunAccess(runId, user.id);
    const projection = await this.runs.getProjection(runId);
    if (!projection) throw new NotFoundException(`Agent Run ${runId} does not exist`);
    return projection;
  }

  @Get('runs/:runId/artifacts')
  public async getArtifacts(@Param('runId') runId: string, @CurrentUser() user: AuthenticatedUser) {
    const projection = await this.getProjection(runId, user);
    return projection.artifacts;
  }

  @Sse('runs/:runId/events')
  public streamEvents(
    @Param('runId') runId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @CurrentUser() user?: AuthenticatedUser,
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
          if (this.authorization && user) await this.authorization.assertRunAccess(runId, user.id);
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
  public async cancelRun(@Param('runId') runId: string, @CurrentUser() user?: AuthenticatedUser) {
    if (this.authorization && user) await this.authorization.assertRunAccess(runId, user.id);
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
  public async steerRun(
    @Param('runId') runId: string,
    @Body() body: RunDirectiveBody,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    if (typeof body.content !== 'string') {
      throw new BadRequestException('content must be a string');
    }
    if (this.authorization && user) await this.authorization.assertRunAccess(runId, user.id);
    try {
      const directive = await this.runs.enqueueSteering(runId, body.content);
      await this.eventBus.publishSteering({
        runId,
        directiveId: directive.directiveId,
        content: body.content.trim(),
      });
      return directive;
    } catch (error) {
      throw mapApplicationError(error);
    }
  }

  @Post('runs/:runId/steering/:directiveId/cancel')
  @HttpCode(200)
  public async cancelSteering(
    @Param('runId') runId: string,
    @Param('directiveId') directiveId: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    if (this.authorization && user) await this.authorization.assertRunAccess(runId, user.id);
    return { cancelled: await this.runs.cancelSteering(runId, directiveId) };
  }

  @Post('runs/:runId/follow-ups')
  @HttpCode(202)
  public async followUpRun(
    @Param('runId') runId: string,
    @Body() body: RunDirectiveBody,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    if (typeof body.content !== 'string') {
      throw new BadRequestException('content must be a string');
    }
    if (this.authorization && user) await this.authorization.assertRunAccess(runId, user.id);
    try {
      return await this.runs.enqueueFollowUp(runId, body.content);
    } catch (error) {
      throw mapApplicationError(error);
    }
  }

  @Post('runs/:runId/follow-ups/:followUpId/cancel')
  @HttpCode(200)
  public async cancelFollowUp(
    @Param('runId') runId: string,
    @Param('followUpId') followUpId: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    if (this.authorization && user) await this.authorization.assertRunAccess(runId, user.id);
    return { cancelled: await this.runs.cancelFollowUp(runId, followUpId) };
  }

  @Post('runs/:runId/questions/:questionId/answer')
  @HttpCode(202)
  public async answerQuestion(
    @Param('runId') runId: string,
    @Param('questionId') questionId: string,
    @Body() body: RunDirectiveBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const answer = typeof body.answer === 'string' ? body.answer : body.content;
    if (typeof answer !== 'string') throw new BadRequestException('answer must be a string');
    await this.authorization?.assertRunAccess(runId, user.id);
    return this.runs.answerQuestion(runId, questionId, answer, user.id);
  }

  @Post('tool-calls/:toolCallId/approval')
  @HttpCode(202)
  public async decideToolCall(
    @Param('toolCallId') toolCallId: string,
    @Body() body: ToolApprovalBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!this.toolCalls) {
      throw new BadRequestException('Tool Call service is unavailable');
    }
    if (body.decision !== 'approved' && body.decision !== 'denied') {
      throw new BadRequestException('decision is required');
    }
    try {
      return await this.toolCalls.decideApproval({
        toolCallId,
        decision: body.decision,
        userId: user.id,
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

function parseStringArray(value: unknown, field: string, maxItems: number): readonly string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 160)
  )
    throw new BadRequestException(`${field} must be an array of at most ${String(maxItems)} IDs`);
  return value as string[];
}

function parseSkills(value: unknown): readonly { skillId: string; version: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8)
    throw new BadRequestException('skills must contain at most 8 versioned selections');
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      throw new BadRequestException('Every Skill selection must be an object');
    const selection = item as Record<string, unknown>;
    if (
      typeof selection.skillId !== 'string' ||
      typeof selection.version !== 'string' ||
      selection.skillId.length === 0 ||
      selection.version.length === 0
    )
      throw new BadRequestException('Every Skill selection requires skillId and version');
    return { skillId: selection.skillId, version: selection.version };
  });
}

function parseContextBindings(
  value: unknown,
): readonly import('@agentpress/agent-application').RunContextBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40)
    throw new BadRequestException('contextBindings must contain at most 40 bindings');
  return value.map((binding) => {
    if (typeof binding !== 'object' || binding === null || Array.isArray(binding))
      throw new BadRequestException('Every context binding must be an object');
    const item = binding as Record<string, unknown>;
    if (item.type === 'mention' && typeof item.targetId === 'string')
      return { type: 'mention', targetId: item.targetId };
    if (item.type === 'attachment' && typeof item.attachmentId === 'string')
      return { type: 'attachment', attachmentId: item.attachmentId };
    if (item.type === 'evidence' && typeof item.evidenceId === 'string')
      return { type: 'evidence', evidenceId: item.evidenceId };
    if (
      item.type === 'skill' &&
      typeof item.skillId === 'string' &&
      typeof item.version === 'string'
    )
      return { type: 'skill', skillId: item.skillId, version: item.version };
    if (
      item.type === 'article_revision' &&
      typeof item.articleId === 'string' &&
      typeof item.revisionId === 'string'
    )
      return { type: 'article_revision', articleId: item.articleId, revisionId: item.revisionId };
    if (
      item.type === 'article_selection' &&
      typeof item.articleId === 'string' &&
      typeof item.revisionId === 'string' &&
      Array.isArray(item.blocks) &&
      item.blocks.length <= 50 &&
      item.blocks.every(isArticleSelectionBlock)
    )
      return {
        type: 'article_selection',
        articleId: item.articleId,
        revisionId: item.revisionId,
        blocks: item.blocks,
      };
    throw new BadRequestException('Unsupported or malformed context binding');
  });
}

function isArticleSelectionBlock(
  block: unknown,
): block is { readonly blockId: string; readonly contentHash: string } {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return false;
  const value = block as Record<string, unknown>;
  return typeof value.blockId === 'string' && typeof value.contentHash === 'string';
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

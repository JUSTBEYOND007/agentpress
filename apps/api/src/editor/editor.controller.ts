import {
  AutosaveService,
  EditorApplicationError,
  ProposalService,
  RedisWriterLease,
} from '@agentpress/editor-application';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { AuthorizationService } from '../auth/authorization.service.js';

type LeaseBody = {
  readonly action?: unknown;
  readonly leaseId?: unknown;
};
type AutosaveBody = {
  readonly updateId?: unknown;
  readonly writerLeaseId?: unknown;
  readonly baseRevisionId?: unknown;
  readonly schemaVersion?: unknown;
  readonly steps?: unknown;
};
type ProposalBody = { readonly decisions?: unknown };
type OperationDecisionBody = { readonly decision?: unknown };
type RevertBatchBody = { readonly userId?: never };
type CommitDraftBody = {
  readonly writerLeaseId?: unknown;
  readonly expectedServerSequence?: unknown;
};

@Controller()
export class EditorController {
  public constructor(
    @Inject(AutosaveService) private readonly autosave: AutosaveService,
    @Inject(ProposalService) private readonly proposals: ProposalService,
    @Inject(RedisWriterLease) private readonly leases: RedisWriterLease,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}
  @Post('articles/:articleId/writer-lease')
  @HttpCode(200)
  public async writerLease(
    @Param('articleId') articleId: string,
    @Body() body: LeaseBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (
      typeof body.leaseId !== 'string' ||
      !['acquire', 'renew', 'release'].includes(String(body.action))
    )
      throw new BadRequestException('action and leaseId are required');
    await this.authorization.assertArticleAccess(articleId, user.id);
    const owned =
      body.action === 'acquire'
        ? (await this.leases.acquire(articleId, user.id, body.leaseId)) ||
          (await this.leases.owns(articleId, user.id, body.leaseId))
        : body.action === 'renew'
          ? await this.leases.renew(articleId, user.id, body.leaseId)
          : await this.leases.release(articleId, user.id, body.leaseId);
    return { articleId, leaseId: body.leaseId, owned };
  }
  @Post('articles/:articleId/autosave')
  @HttpCode(200)
  public async save(
    @Param('articleId') articleId: string,
    @Body() body: AutosaveBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (
      typeof body.updateId !== 'string' ||
      typeof body.writerLeaseId !== 'string' ||
      typeof body.baseRevisionId !== 'string' ||
      typeof body.schemaVersion !== 'number' ||
      !Array.isArray(body.steps)
    )
      throw new BadRequestException('Invalid AutosaveBatch');
    await this.authorization.assertArticleAccess(articleId, user.id);
    try {
      return await this.autosave.save({
        articleId,
        updateId: body.updateId,
        userId: user.id,
        writerLeaseId: body.writerLeaseId,
        baseRevisionId: body.baseRevisionId,
        schemaVersion: body.schemaVersion,
        steps: body.steps,
      });
    } catch (error) {
      throw mapEditorError(error);
    }
  }
  @Get('articles/:articleId/draft')
  public async recover(
    @Param('articleId') articleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertArticleAccess(articleId, user.id);
    const draft = await this.autosave.recover(articleId, user.id);
    if (!draft) return { document: null };
    return draft;
  }
  @Post('articles/:articleId/draft/commit')
  @HttpCode(200)
  public async commitDraft(
    @Param('articleId') articleId: string,
    @Body() body: CommitDraftBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (
      typeof body.writerLeaseId !== 'string' ||
      typeof body.expectedServerSequence !== 'number' ||
      !Number.isSafeInteger(body.expectedServerSequence) ||
      body.expectedServerSequence < 1
    )
      throw new BadRequestException('Invalid draft commit request');
    await this.authorization.assertArticleAccess(articleId, user.id);
    try {
      return await this.autosave.commit({
        articleId,
        userId: user.id,
        writerLeaseId: body.writerLeaseId,
        expectedServerSequence: body.expectedServerSequence,
      });
    } catch (error) {
      throw mapEditorError(error);
    }
  }
  @Post('edit-proposals/:proposalId/decisions')
  @HttpCode(200)
  public async decide(
    @Param('proposalId') proposalId: string,
    @Body() body: ProposalBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (
      typeof body.decisions !== 'object' ||
      body.decisions === null ||
      Array.isArray(body.decisions)
    )
      throw new BadRequestException('decisions are required');
    await this.authorization.assertProposalAccess(proposalId, user.id);
    const decisions = body.decisions as Record<string, unknown>;
    if (!Object.values(decisions).every((value) => value === 'accepted' || value === 'rejected'))
      throw new BadRequestException('Every decision must be accepted or rejected');
    try {
      return await this.proposals.decide({
        proposalId,
        userId: user.id,
        decisions: decisions as Record<string, 'accepted' | 'rejected'>,
      });
    } catch (error) {
      throw mapEditorError(error);
    }
  }

  @Get('articles/:articleId/edit-proposals/pending')
  public async pendingProposal(
    @Param('articleId') articleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertArticleAccess(articleId, user.id);
    return { proposal: (await this.proposals.getPending(articleId)) ?? null };
  }

  @Post('edit-proposals/:proposalId/operations/:operationId/decision')
  @HttpCode(200)
  public async decideOperation(
    @Param('proposalId') proposalId: string,
    @Param('operationId') operationId: string,
    @Body() body: OperationDecisionBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (body.decision !== 'accepted' && body.decision !== 'rejected') {
      throw new BadRequestException('decision must be accepted or rejected');
    }
    await this.authorization.assertProposalAccess(proposalId, user.id);
    try {
      return await this.proposals.decideOperation({
        proposalId,
        operationId,
        userId: user.id,
        decision: body.decision,
      });
    } catch (error) {
      throw mapEditorError(error);
    }
  }

  @Post('edit-proposals/:proposalId/batches/:batchId/revert')
  @HttpCode(200)
  public async revertBatch(
    @Param('proposalId') proposalId: string,
    @Param('batchId') batchId: string,
    @Body() _body: RevertBatchBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertProposalAccess(proposalId, user.id);
    try {
      return await this.proposals.revertBatch({ proposalId, batchId, userId: user.id });
    } catch (error) {
      throw mapEditorError(error);
    }
  }
}
function mapEditorError(error: unknown): Error {
  if (error instanceof EditorApplicationError)
    return error.code === 'article_not_found' || error.code === 'draft_not_found'
      ? new NotFoundException(error.message)
      : new BadRequestException(error.message);
  return error instanceof Error
    ? new BadRequestException(error.message)
    : new BadRequestException('Unknown editor error');
}

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
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';

type LeaseBody = {
  readonly action?: unknown;
  readonly userId?: unknown;
  readonly leaseId?: unknown;
};
type AutosaveBody = {
  readonly updateId?: unknown;
  readonly userId?: unknown;
  readonly writerLeaseId?: unknown;
  readonly baseRevisionId?: unknown;
  readonly schemaVersion?: unknown;
  readonly steps?: unknown;
};
type ProposalBody = { readonly userId?: unknown; readonly decisions?: unknown };

@Controller()
export class EditorController {
  public constructor(
    private readonly autosave: AutosaveService,
    private readonly proposals: ProposalService,
    private readonly leases: RedisWriterLease,
  ) {}
  @Post('articles/:articleId/writer-lease')
  @HttpCode(200)
  public async writerLease(@Param('articleId') articleId: string, @Body() body: LeaseBody) {
    if (
      typeof body.userId !== 'string' ||
      typeof body.leaseId !== 'string' ||
      !['acquire', 'renew', 'release'].includes(String(body.action))
    )
      throw new BadRequestException('action, userId and leaseId are required');
    const owned =
      body.action === 'acquire'
        ? await this.leases.acquire(articleId, body.userId, body.leaseId)
        : body.action === 'renew'
          ? await this.leases.renew(articleId, body.userId, body.leaseId)
          : await this.leases.release(articleId, body.userId, body.leaseId);
    return { articleId, leaseId: body.leaseId, owned };
  }
  @Post('articles/:articleId/autosave')
  @HttpCode(200)
  public async save(@Param('articleId') articleId: string, @Body() body: AutosaveBody) {
    if (
      typeof body.updateId !== 'string' ||
      typeof body.userId !== 'string' ||
      typeof body.writerLeaseId !== 'string' ||
      typeof body.baseRevisionId !== 'string' ||
      typeof body.schemaVersion !== 'number' ||
      !Array.isArray(body.steps)
    )
      throw new BadRequestException('Invalid AutosaveBatch');
    try {
      return await this.autosave.save({
        articleId,
        updateId: body.updateId,
        userId: body.userId,
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
    @Query('userId') userId: string | undefined,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    const draft = await this.autosave.recover(articleId, userId);
    if (!draft) throw new NotFoundException('Draft does not exist');
    return draft;
  }
  @Post('edit-proposals/:proposalId/decisions')
  @HttpCode(200)
  public async decide(@Param('proposalId') proposalId: string, @Body() body: ProposalBody) {
    if (
      typeof body.userId !== 'string' ||
      typeof body.decisions !== 'object' ||
      body.decisions === null ||
      Array.isArray(body.decisions)
    )
      throw new BadRequestException('userId and decisions are required');
    const decisions = body.decisions as Record<string, unknown>;
    if (!Object.values(decisions).every((value) => value === 'accepted' || value === 'rejected'))
      throw new BadRequestException('Every decision must be accepted or rejected');
    try {
      return await this.proposals.decide({
        proposalId,
        userId: body.userId,
        decisions: decisions as Record<string, 'accepted' | 'rejected'>,
      });
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

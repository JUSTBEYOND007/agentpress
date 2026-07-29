import { createHash } from 'node:crypto';

import { PublicationError, PublicationService } from '@agentpress/publication-application';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';

@Controller()
export class PublicationController {
  public constructor(
    @Inject(PublicationService) private readonly publications: PublicationService,
  ) {}

  @Post('articles/:articleId/publications')
  @HttpCode(201)
  public async publish(
    @Param('articleId') articleId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (
      typeof body.revisionId !== 'string' ||
      typeof body.userId !== 'string' ||
      typeof body.slug !== 'string' ||
      (body.coverAssetId !== undefined && typeof body.coverAssetId !== 'string')
    ) {
      throw new BadRequestException('revisionId, userId and slug are required');
    }
    try {
      return await this.publications.publish({
        articleId,
        revisionId: body.revisionId,
        userId: body.userId,
        slug: body.slug,
        ...(body.coverAssetId ? { coverAssetId: body.coverAssetId } : {}),
      });
    } catch (error) {
      throw mapPublicationError(error);
    }
  }

  @Get('publications/:slug')
  public async getPublication(@Param('slug') slug: string) {
    const article = await this.publications.findBySlug(slug);
    if (!article) throw new NotFoundException('Publication not found');
    return article;
  }

  @Get('trending')
  public async trending(@Query('limit') rawLimit: string | undefined) {
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new BadRequestException('limit must be an integer between 1 and 50');
    }
    return this.publications.trending(limit);
  }

  @Post('publications/:publicationId/reaction')
  public async react(
    @Param('publicationId') publicationId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (typeof body.userId !== 'string' || (body.reaction !== 'up' && body.reaction !== 'down')) {
      throw new BadRequestException('userId and reaction are required');
    }
    try {
      return await this.publications.react(publicationId, body.userId, body.reaction);
    } catch (error) {
      throw mapPublicationError(error);
    }
  }

  @Post('publications/:publicationId/views')
  public async view(
    @Param('publicationId') publicationId: string,
    @Headers('x-viewer-id') viewerId: string | undefined,
  ) {
    if (!viewerId || viewerId.length > 300) {
      throw new BadRequestException('x-viewer-id is required');
    }
    const viewerHash = createHash('sha256').update(viewerId).digest('hex');
    try {
      return await this.publications.recordView(publicationId, viewerHash);
    } catch (error) {
      throw mapPublicationError(error);
    }
  }
}

function mapPublicationError(error: unknown): Error {
  if (error instanceof PublicationError) {
    return error.code === 'not_found'
      ? new NotFoundException(error.message)
      : new BadRequestException(error.message);
  }
  return error instanceof Error ? error : new Error('Unknown publication error');
}

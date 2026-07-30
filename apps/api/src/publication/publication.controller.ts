import { createHash } from 'node:crypto';

import { PublicationError, PublicationService } from '@agentpress/publication-application';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { PublicRoute } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { AuthorizationService } from '../auth/authorization.service.js';

@Controller()
export class PublicationController {
  public constructor(
    @Inject(PublicationService) private readonly publications: PublicationService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  @Post('articles/:articleId/publications')
  @HttpCode(201)
  public async publish(
    @Param('articleId') articleId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (
      typeof body.revisionId !== 'string' ||
      typeof body.slug !== 'string' ||
      (body.coverAssetId !== undefined && typeof body.coverAssetId !== 'string')
    ) {
      throw new BadRequestException('revisionId and slug are required');
    }
    await this.authorization.assertArticleAccess(articleId, user.id);
    try {
      return await this.publications.publish({
        articleId,
        revisionId: body.revisionId,
        userId: user.id,
        slug: body.slug,
        ...(body.coverAssetId ? { coverAssetId: body.coverAssetId } : {}),
      });
    } catch (error) {
      throw mapPublicationError(error);
    }
  }

  @Get('articles/:articleId/publications')
  public async listArticlePublications(
    @Param('articleId') articleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertArticleAccess(articleId, user.id);
    return this.publications.listForArticle(articleId);
  }

  @Delete('articles/:articleId/publications/:publicationId')
  public async unpublish(
    @Param('articleId') articleId: string,
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertArticleAccess(articleId, user.id);
    try {
      return await this.publications.unpublish(articleId, publicationId);
    } catch (error) {
      throw mapPublicationError(error);
    }
  }

  @Get('publications/:slug')
  @PublicRoute()
  public async getPublication(@Param('slug') slug: string) {
    const article = await this.publications.findBySlug(slug);
    if (!article) throw new NotFoundException('Publication not found');
    return article;
  }

  @Get('trending')
  @PublicRoute()
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
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (body.reaction !== 'up' && body.reaction !== 'down') {
      throw new BadRequestException('reaction is required');
    }
    try {
      return await this.publications.react(publicationId, user.id, body.reaction);
    } catch (error) {
      throw mapPublicationError(error);
    }
  }

  @Post('publications/:publicationId/views')
  @PublicRoute()
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

import { AttachmentService, MediaService } from '@agentpress/media-application';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
  StreamableFile,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Req } from '@nestjs/common';
import { PublicRoute } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { AuthorizationService } from '../auth/authorization.service.js';

@Controller()
export class MediaController {
  public constructor(
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(AttachmentService) private readonly attachments: AttachmentService,
    @Inject(AuthorizationService) private readonly authorization?: AuthorizationService,
  ) {}

  @Post('workspaces/:workspaceId/attachments')
  public async uploadAttachment(
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization?.assertWorkspaceMember(workspaceId, user.id);
    const body = request.body;
    if (!(body instanceof Buffer) && !(body instanceof Uint8Array)) {
      throw new BadRequestException('Attachment body must be raw bytes');
    }
    const filename = firstHeader(request.headers['x-file-name']);
    const mimeType = firstHeader(request.headers['content-type']);
    if (!filename || !mimeType) {
      throw new BadRequestException('x-file-name and content-type headers are required');
    }
    try {
      return await this.attachments.upload({
        workspaceId,
        uploadedByUserId: user.id,
        filename: decodeURIComponent(filename),
        mimeType: mimeType.split(';')[0]?.trim() ?? mimeType,
        bytes: Buffer.from(body),
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Attachment upload failed',
      );
    }
  }

  @Get('workspaces/:workspaceId/media')
  public async list(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization?.assertWorkspaceMember(workspaceId, user.id);
    return this.media.list(workspaceId);
  }

  @Post('media/generate')
  public generate(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthenticatedUser) {
    void body;
    void user;
    throw new BadRequestException(
      'Image generation is only available through an approved Agent Tool Call',
    );
  }

  @Get('media/:assetId/content')
  @PublicRoute()
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  public async content(@Param('assetId') assetId: string): Promise<StreamableFile> {
    const asset = await this.media.read(assetId);
    if (!asset) throw new NotFoundException('Media asset not found');
    return new StreamableFile(asset.bytes, {
      type: asset.mimeType,
      length: asset.bytes.byteLength,
    });
  }
}

function firstHeader(value: string | readonly string[] | undefined): string {
  if (typeof value === 'string') return value;
  return value?.[0] ?? '';
}

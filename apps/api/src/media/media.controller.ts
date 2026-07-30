import { MediaService } from '@agentpress/media-application';
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
import { PublicRoute } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';

@Controller()
export class MediaController {
  public constructor(@Inject(MediaService) private readonly media: MediaService) {}

  @Post('media/generate')
  public async generate(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (typeof body.approvedToolCallId !== 'string' || typeof body.prompt !== 'string') {
      throw new BadRequestException('approvedToolCallId and prompt are required');
    }
    try {
      return await this.media.generate({
        approvedToolCallId: body.approvedToolCallId,
        userId: user.id,
        prompt: body.prompt,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Media generation failed',
      );
    }
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

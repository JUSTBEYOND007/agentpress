import type { MediaService } from '@agentpress/media-application';
import { PublicationError, type PublicationService } from '@agentpress/publication-application';
import { BadRequestException, NotFoundException, StreamableFile } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { MediaController } from '../src/media/media.controller.js';
import { PublicationController } from '../src/publication/publication.controller.js';
import type { AuthorizationService } from '../src/auth/authorization.service.js';
import type { AuthenticatedUser } from '../src/auth/auth.service.js';

const user: AuthenticatedUser = { id: 'user-1', subject: 'subject', displayName: 'User' };
const authorization = {
  assertArticleAccess: vi.fn(() => Promise.resolve()),
} as unknown as AuthorizationService;

describe('PublicationController', () => {
  it('publishes the exact immutable revision and optional cover', async () => {
    const publish = vi.fn(() => Promise.resolve({ publicationId: 'publication-1' }));
    const controller = new PublicationController(
      { publish } as unknown as PublicationService,
      authorization,
    );

    await controller.publish(
      'article-1',
      {
        revisionId: 'revision-3',
        slug: 'agent-writing',
        coverAssetId: 'asset-1',
      },
      user,
    );

    expect(publish).toHaveBeenCalledWith({
      articleId: 'article-1',
      revisionId: 'revision-3',
      userId: 'user-1',
      slug: 'agent-writing',
      coverAssetId: 'asset-1',
    });
  });

  it('rejects invalid ranking limits before querying storage', async () => {
    const trending = vi.fn();
    const controller = new PublicationController(
      { trending } as unknown as PublicationService,
      authorization,
    );

    await expect(controller.trending('51')).rejects.toBeInstanceOf(BadRequestException);
    expect(trending).not.toHaveBeenCalled();
  });

  it('hashes viewer identifiers before recording a view', async () => {
    const recordView = vi.fn(() => Promise.resolve({ counted: true }));
    const controller = new PublicationController(
      { recordView } as unknown as PublicationService,
      authorization,
    );

    await controller.view('publication-1', 'private-browser-id');

    expect(recordView).toHaveBeenCalledWith(
      'publication-1',
      'd8c4d5de6529e81c16270ad5295cc290b251a11120a2facce8afa90fc1cee731',
    );
  });

  it('maps publication domain errors to HTTP errors', async () => {
    const findBySlug = vi.fn(() => Promise.resolve(null));
    const react = vi.fn(() =>
      Promise.reject(new PublicationError('not_found', 'Publication or user not found')),
    );
    const controller = new PublicationController(
      { findBySlug, react } as unknown as PublicationService,
      authorization,
    );

    await expect(controller.getPublication('missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.react('missing', { reaction: 'up' }, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('MediaController', () => {
  it('rejects direct image generation outside the Agent Tool ledger', () => {
    const controller = new MediaController({} as MediaService);
    expect(() => {
      controller.generate({ approvedToolCallId: 'tool-call-1', prompt: 'Illustration' }, user);
    }).toThrow(BadRequestException);
  });

  it('returns stored bytes as an immutable stream', async () => {
    const read = vi.fn(() =>
      Promise.resolve({ bytes: Buffer.from('image-bytes'), mimeType: 'image/png' }),
    );
    const controller = new MediaController({ read } as unknown as MediaService);

    const response = await controller.content('asset-1');

    expect(response).toBeInstanceOf(StreamableFile);
    expect(response.getHeaders()).toMatchObject({ type: 'image/png', length: 11 });
  });
});

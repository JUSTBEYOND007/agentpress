import type {
  AutosaveService,
  ProposalService,
  RedisWriterLease,
} from '@agentpress/editor-application';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EditorController } from '../src/editor/editor.controller.js';
import type { AuthorizationService } from '../src/auth/authorization.service.js';
import type { AuthenticatedUser } from '../src/auth/auth.service.js';

const user: AuthenticatedUser = { id: 'user', subject: 'subject', displayName: 'User' };
const authorization = {
  assertArticleAccess: vi.fn(() => Promise.resolve()),
  assertProposalAccess: vi.fn(() => Promise.resolve()),
} as unknown as AuthorizationService;

describe('EditorController', () => {
  it('passes a complete AutosaveBatch to the service', async () => {
    const save = vi.fn((input: unknown) => Promise.resolve(input));
    const controller = new EditorController(
      { save } as AutosaveService,
      {} as ProposalService,
      {} as RedisWriterLease,
      authorization,
    );
    await controller.save(
      'article',
      {
        updateId: 'update',
        writerLeaseId: 'lease',
        baseRevisionId: 'revision',
        schemaVersion: 1,
        steps: [{ stepType: 'replace' }],
      },
      user,
    );
    expect(save).toHaveBeenCalledWith({
      articleId: 'article',
      updateId: 'update',
      userId: 'user',
      writerLeaseId: 'lease',
      baseRevisionId: 'revision',
      schemaVersion: 1,
      steps: [{ stepType: 'replace' }],
    });
  });
  it('rejects invalid proposal decisions before persistence', async () => {
    const controller = new EditorController(
      {} as AutosaveService,
      {} as ProposalService,
      {} as RedisWriterLease,
      authorization,
    );
    await expect(
      controller.decide('proposal', { decisions: { op: 'maybe' } }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('treats an existing lease owned by the same browser as acquired', async () => {
    const leases = {
      acquire: vi.fn(() => Promise.resolve(false)),
      owns: vi.fn(() => Promise.resolve(true)),
    } as unknown as RedisWriterLease;
    const controller = new EditorController(
      {} as AutosaveService,
      {} as ProposalService,
      leases,
      authorization,
    );

    await expect(
      controller.writerLease(
        'article',
        {
          action: 'acquire',
          leaseId: 'browser-session',
        },
        user,
      ),
    ).resolves.toEqual({ articleId: 'article', leaseId: 'browser-session', owned: true });
  });
});

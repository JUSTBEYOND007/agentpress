import type { DatabaseConnection } from '@agentpress/database';
import type { ConversationOverviewService } from '@agentpress/agent-application';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceController } from '../src/workspace/workspace.controller.js';
import type { AuthorizationService } from '../src/auth/authorization.service.js';
import type { AuthenticatedUser } from '../src/auth/auth.service.js';

describe('WorkspaceController', () => {
  const controller = new WorkspaceController(
    {} as DatabaseConnection,
    {} as AuthorizationService,
    {} as ConversationOverviewService,
  );
  const user: AuthenticatedUser = { id: 'user', subject: 'subject', displayName: 'User' };

  it('rejects an empty article title before opening a transaction', async () => {
    await expect(
      controller.createArticle('workspace', { title: '   ' }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects article creation without a title', async () => {
    await expect(controller.createArticle('workspace', {}, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('authorizes article conversation overviews before querying persisted facts', async () => {
    const assertArticleAccess = vi.fn(() => Promise.resolve());
    const listForArticle = vi.fn(() => Promise.resolve([{ id: 'conversation' }]));
    const authorization = {
      assertArticleAccess,
    } as unknown as AuthorizationService;
    const overviews = {
      listForArticle,
    } as unknown as ConversationOverviewService;
    const queryController = new WorkspaceController(
      {} as DatabaseConnection,
      authorization,
      overviews,
    );

    await expect(queryController.listConversations('article', user)).resolves.toEqual([
      { id: 'conversation' },
    ]);
    expect(assertArticleAccess).toHaveBeenCalledWith('article', user.id);
    expect(listForArticle).toHaveBeenCalledWith('article', user.id);
  });

  it('authorizes the exact branch before changing its read cursor', async () => {
    const assertConversationBranchAccess = vi.fn(() => Promise.resolve());
    const markRead = vi.fn(() => Promise.resolve());
    const authorization = {
      assertConversationBranchAccess,
    } as unknown as AuthorizationService;
    const overviews = {
      markRead,
    } as unknown as ConversationOverviewService;
    const queryController = new WorkspaceController(
      {} as DatabaseConnection,
      authorization,
      overviews,
    );

    await expect(
      queryController.markConversationRead('conversation', 'branch', user),
    ).resolves.toEqual({
      read: true,
    });
    expect(assertConversationBranchAccess).toHaveBeenCalledWith('conversation', 'branch', user.id);
    expect(markRead).toHaveBeenCalledWith(user.id, 'branch');
  });
});

import type { DatabaseConnection } from '@agentpress/database';
import type { ConversationOverviewService } from '@agentpress/agent-application';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import {
  ensureWorkspaceDefaultConversation,
  WorkspaceController,
} from '../src/workspace/workspace.controller.js';
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

  it('authorizes workspace conversation overviews before querying persisted facts', async () => {
    const assertWorkspaceMember = vi.fn(() => Promise.resolve());
    const listForWorkspace = vi.fn(() => Promise.resolve([{ id: 'conversation' }]));
    const authorization = { assertWorkspaceMember } as unknown as AuthorizationService;
    const overviews = { listForWorkspace } as unknown as ConversationOverviewService;
    const queryController = new WorkspaceController(
      {} as DatabaseConnection,
      authorization,
      overviews,
    );

    await expect(queryController.listWorkspaceConversations('workspace', user)).resolves.toEqual([
      { id: 'conversation' },
    ]);
    expect(assertWorkspaceMember).toHaveBeenCalledWith('workspace', user.id);
    expect(listForWorkspace).toHaveBeenCalledWith('workspace', user.id);
  });

  it('creates one default workspace conversation when no persisted conversation exists', async () => {
    const values = vi.fn(() => Promise.resolve());
    const insert = vi.fn(() => ({ values }));
    const transaction = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
        })),
      })),
      insert,
    };

    await ensureWorkspaceDefaultConversation(transaction as never, 'workspace');

    expect(insert).toHaveBeenCalledTimes(2);
    const createdConversation = values.mock.calls[0]?.[0] as { readonly id: string };
    expect(values).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: 'workspace',
        articleId: null,
        title: '写作助手',
        isDefault: true,
      }),
    );
    expect(values).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ conversationId: createdConversation.id }),
    );
  });

  it('preserves an existing default workspace conversation', async () => {
    const insert = vi.fn();
    const transaction = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([{ id: 'conversation' }])),
          })),
        })),
      })),
      insert,
    };

    await ensureWorkspaceDefaultConversation(transaction as never, 'workspace');

    expect(insert).not.toHaveBeenCalled();
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

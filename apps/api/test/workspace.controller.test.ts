import type { DatabaseConnection } from '@agentpress/database';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { WorkspaceController } from '../src/workspace/workspace.controller.js';
import type { AuthorizationService } from '../src/auth/authorization.service.js';
import type { AuthenticatedUser } from '../src/auth/auth.service.js';

describe('WorkspaceController', () => {
  const controller = new WorkspaceController({} as DatabaseConnection, {} as AuthorizationService);
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
});

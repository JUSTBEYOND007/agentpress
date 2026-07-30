import type { DatabaseConnection } from '@agentpress/database';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { WorkspaceController } from '../src/workspace/workspace.controller.js';

describe('WorkspaceController', () => {
  const controller = new WorkspaceController({} as DatabaseConnection);

  it('rejects an empty article title before opening a transaction', async () => {
    await expect(
      controller.createArticle('workspace', { title: '   ', userId: 'user' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects article creation without a user identity', async () => {
    await expect(
      controller.createArticle('workspace', { title: 'Article' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

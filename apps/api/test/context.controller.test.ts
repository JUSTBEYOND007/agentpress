import type { ContextGovernanceService } from '@agentpress/agent-application';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ContextController } from '../src/context/context.controller.js';
import type { AuthorizationService } from '../src/auth/authorization.service.js';
import type { AuthenticatedUser } from '../src/auth/auth.service.js';

const user: AuthenticatedUser = { id: 'user', subject: 'subject', displayName: 'User' };

describe('ContextController', () => {
  it('requires editor permission and persists a declarative Skill', async () => {
    const createSkill = vi.fn(() => Promise.resolve({ skillId: 'news', version: '1.0.0' }));
    const authorization = {
      assertWorkspaceEditor: vi.fn(() => Promise.resolve()),
    } as unknown as AuthorizationService;
    const controller = new ContextController(
      { createSkill } as unknown as ContextGovernanceService,
      authorization,
    );
    await expect(controller.createSkill('workspace', { markdown: 'skill' }, user)).resolves.toEqual(
      {
        skillId: 'news',
        version: '1.0.0',
      },
    );
    expect(createSkill).toHaveBeenCalledWith('workspace', 'skill');
  });

  it('rejects invalid memory decisions before persistence', async () => {
    const authorization = {
      assertWorkspaceMember: vi.fn(() => Promise.resolve()),
    } as unknown as AuthorizationService;
    const controller = new ContextController({} as ContextGovernanceService, authorization);
    await expect(
      controller.decideMemory('workspace', 'memory', { decision: 'maybe' }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

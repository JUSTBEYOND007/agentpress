import { ContextGovernanceService } from '@agentpress/agent-application';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { AuthorizationService } from '../auth/authorization.service.js';

@Controller()
export class ContextController {
  public constructor(
    @Inject(ContextGovernanceService) private readonly contexts: ContextGovernanceService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  @Get('workspaces/:workspaceId/skills')
  public async listSkills(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    return this.contexts.listSkills(workspaceId);
  }

  @Post('workspaces/:workspaceId/skills')
  public async createSkill(
    @Param('workspaceId') workspaceId: string,
    @Body() body: { readonly markdown?: unknown },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceEditor(workspaceId, user.id);
    if (typeof body.markdown !== 'string') throw new BadRequestException('markdown is required');
    try {
      return await this.contexts.createSkill(workspaceId, body.markdown);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid Skill');
    }
  }

  @Get('workspaces/:workspaceId/memories')
  public async listMemories(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    return this.contexts.listMemories(workspaceId, user.id);
  }

  @Get('workspaces/:workspaceId/memories/export')
  public async exportMemories(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    return this.contexts.exportMemories(workspaceId, user.id);
  }

  @Delete('workspaces/:workspaceId/memories/:candidateId')
  public async deleteMemory(
    @Param('workspaceId') workspaceId: string,
    @Param('candidateId') candidateId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    try {
      return await this.contexts.deleteMemory(workspaceId, user.id, candidateId);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid memory deletion',
      );
    }
  }

  @Post('workspaces/:workspaceId/memories/:candidateId/decision')
  public async decideMemory(
    @Param('workspaceId') workspaceId: string,
    @Param('candidateId') candidateId: string,
    @Body() body: { readonly decision?: unknown },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    if (body.decision !== 'accepted' && body.decision !== 'rejected')
      throw new BadRequestException('decision must be accepted or rejected');
    try {
      return await this.contexts.decideMemory(workspaceId, user.id, candidateId, body.decision);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid memory decision',
      );
    }
  }
}

import {
  agentRuns,
  articles,
  conversationBranches,
  conversations,
  type AgentPressDatabase,
  editProposals,
  workspaceMembers,
} from '@agentpress/database';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

@Injectable()
export class AuthorizationService {
  public constructor(private readonly database: AgentPressDatabase) {}

  public async assertWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
    const rows = await this.database
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);
    if (!rows[0]) throw new ForbiddenException('User is not a member of this workspace');
  }

  public async assertWorkspaceEditor(workspaceId: string, userId: string): Promise<void> {
    const rows = await this.database
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);
    if (!rows[0] || rows[0].role === 'viewer')
      throw new ForbiddenException('Workspace editor permission is required');
  }

  public async assertArticleAccess(articleId: string, userId: string): Promise<void> {
    const rows = await this.database
      .select({ workspaceId: articles.workspaceId })
      .from(articles)
      .where(eq(articles.id, articleId))
      .limit(1);
    if (!rows[0]) throw new NotFoundException('Article does not exist');
    await this.assertWorkspaceMember(rows[0].workspaceId, userId);
  }

  public async assertRunAccess(runId: string, userId: string): Promise<void> {
    const rows = await this.database
      .select({ workspaceId: agentRuns.workspaceId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    if (!rows[0]) throw new NotFoundException('Agent Run does not exist');
    await this.assertWorkspaceMember(rows[0].workspaceId, userId);
  }

  public async assertConversationBranchAccess(
    conversationId: string,
    branchId: string,
    userId: string,
  ): Promise<void> {
    const rows = await this.database
      .select({ workspaceId: conversations.workspaceId })
      .from(conversationBranches)
      .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
      .where(and(eq(conversations.id, conversationId), eq(conversationBranches.id, branchId)))
      .limit(1);
    if (!rows[0]) throw new NotFoundException('Conversation branch does not exist');
    await this.assertWorkspaceMember(rows[0].workspaceId, userId);
  }

  public async assertProposalAccess(proposalId: string, userId: string): Promise<void> {
    const rows = await this.database
      .select({ articleId: editProposals.articleId })
      .from(editProposals)
      .where(eq(editProposals.id, proposalId))
      .limit(1);
    if (!rows[0]) throw new NotFoundException('Edit Proposal does not exist');
    await this.assertArticleAccess(rows[0].articleId, userId);
  }
}

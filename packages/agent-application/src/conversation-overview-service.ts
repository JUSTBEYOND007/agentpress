import {
  agentRuns,
  conversationBranches,
  conversationReadStates,
  conversations,
  editProposalBatches,
  editProposals,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, desc, eq, inArray } from 'drizzle-orm';

export class ConversationOverviewService {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listForArticle(articleId: string, userId: string) {
    const branches = await this.database
      .select({
        id: conversations.id,
        title: conversations.title,
        isDefault: conversations.isDefault,
        archivedAt: conversations.archivedAt,
        branchId: conversationBranches.id,
        parentBranchId: conversationBranches.parentBranchId,
        forkedFromMessageId: conversationBranches.forkedFromMessageId,
        branchCreatedAt: conversationBranches.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .innerJoin(conversationBranches, eq(conversationBranches.conversationId, conversations.id))
      .where(eq(conversations.articleId, articleId))
      .orderBy(desc(conversations.updatedAt), desc(conversationBranches.createdAt));
    const branchIds = branches.map(({ branchId }) => branchId);
    if (branchIds.length === 0) return [];

    const [runs, readStates, proposalRuns, batchRuns] = await Promise.all([
      this.database
        .select({
          id: agentRuns.id,
          branchId: agentRuns.branchId,
          status: agentRuns.status,
          completedAt: agentRuns.completedAt,
          updatedAt: agentRuns.updatedAt,
        })
        .from(agentRuns)
        .where(inArray(agentRuns.branchId, branchIds))
        .orderBy(desc(agentRuns.createdAt)),
      this.database
        .select({
          branchId: conversationReadStates.branchId,
          lastReadAt: conversationReadStates.lastReadAt,
        })
        .from(conversationReadStates)
        .where(
          and(
            eq(conversationReadStates.userId, userId),
            inArray(conversationReadStates.branchId, branchIds),
          ),
        ),
      this.database
        .select({ runId: editProposals.runId })
        .from(editProposals)
        .where(and(eq(editProposals.articleId, articleId), eq(editProposals.status, 'pending'))),
      this.database
        .select({ runId: editProposalBatches.runId })
        .from(editProposalBatches)
        .innerJoin(editProposals, eq(editProposals.id, editProposalBatches.proposalId))
        .where(and(eq(editProposals.articleId, articleId), eq(editProposals.status, 'pending'))),
    ]);
    const latestRunByBranch = new Map<string, (typeof runs)[number]>();
    const branchByRun = new Map<string, string>();
    for (const run of runs) {
      branchByRun.set(run.id, run.branchId);
      if (!latestRunByBranch.has(run.branchId)) latestRunByBranch.set(run.branchId, run);
    }
    const pendingReviewBranches = new Set<string>();
    for (const { runId } of [...proposalRuns, ...batchRuns]) {
      if (!runId) continue;
      const proposalBranchId = branchByRun.get(runId);
      if (proposalBranchId) pendingReviewBranches.add(proposalBranchId);
    }
    const readAtByBranch = new Map(
      readStates.map(({ branchId, lastReadAt }) => [branchId, lastReadAt]),
    );

    return branches.map((branch) => {
      const latestRun = latestRunByBranch.get(branch.branchId);
      const lastReadAt = readAtByBranch.get(branch.branchId);
      const terminalAt = latestRun?.completedAt;
      return {
        ...branch,
        status: latestRun?.status ?? 'ready',
        latestRunId: latestRun?.id,
        pendingReview: pendingReviewBranches.has(branch.branchId),
        unread: Boolean(terminalAt && (!lastReadAt || terminalAt > lastReadAt)),
      };
    });
  }

  public async markRead(userId: string, branchId: string): Promise<void> {
    const now = this.now();
    await this.database
      .insert(conversationReadStates)
      .values({ userId, branchId, lastReadAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [conversationReadStates.userId, conversationReadStates.branchId],
        set: { lastReadAt: now, updatedAt: now },
      });
  }
}

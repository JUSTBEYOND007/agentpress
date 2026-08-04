import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  appendConversationCompaction,
  agentRuns,
  actionProposals,
  appUsers,
  approvals,
  artifacts,
  artifactVersions,
  articleRevisions,
  articles,
  collectConversationCompactionPreserveData,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  evidenceRecords,
  editProposalBatches,
  editProposals,
  getEffectiveConversationCompaction,
  memoryCandidates,
  modelSelections,
  mentionBindings,
  rootRequests,
  runSkillBindings,
  skillRevisions,
  toolCalls,
  workspaces,
} from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Conversation compaction persistence', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
    branchA: randomUUID(),
    branchB: randomUUID(),
    rootMessage: randomUUID(),
    request: randomUUID(),
    run: randomUUID(),
    tool: randomUUID(),
    approval: randomUUID(),
    evidence: randomUUID(),
    memory: randomUUID(),
    modelSelection: randomUUID(),
    article: randomUUID(),
    articleRevision: randomUUID(),
    artifact: randomUUID(),
    artifactVersion: randomUUID(),
    skillRevision: randomUUID(),
    mention: randomUUID(),
    editProposal: randomUUID(),
    editProposalBatch: randomUUID(),
    actionProposal: randomUUID(),
  };

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Compaction User',
    });
    await connection.db.insert(workspaces).values({ id: ids.workspace, name: 'Compaction' });
    await connection.db
      .insert(conversations)
      .values({ id: ids.conversation, workspaceId: ids.workspace, title: 'Compaction' });
    await connection.db.insert(articles).values({
      id: ids.article,
      workspaceId: ids.workspace,
      title: 'Protected article',
    });
    await connection.db.insert(articleRevisions).values({
      id: ids.articleRevision,
      articleId: ids.article,
      revisionNumber: 1,
      schemaVersion: 1,
      document: { type: 'doc', content: [] },
      documentHash: 'sha256:article-revision',
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId: ids.articleRevision })
      .where(eq(articles.id, ids.article));
    await connection.db.insert(conversationBranches).values([
      { id: ids.branchA, conversationId: ids.conversation },
      { id: ids.branchB, conversationId: ids.conversation, parentBranchId: ids.branchA },
    ]);
    for (const branchId of [ids.branchA, ids.branchB]) {
      await connection.db.insert(conversationMessages).values(
        Array.from({ length: 6 }, (_, index) => ({
          id: branchId === ids.branchA && index === 0 ? ids.rootMessage : randomUUID(),
          branchId,
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          sequence: index + 1,
          content: [{ type: 'text', text: `${branchId}:${String(index + 1)}` }],
          stable: true,
        })),
      );
    }
    await connection.db.insert(rootRequests).values({
      id: ids.request,
      branchId: ids.branchA,
      messageId: ids.rootMessage,
      requestedByUserId: ids.user,
      idempotencyKey: `compaction:${ids.request}`,
    });
    await connection.db.insert(agentRuns).values({
      id: ids.run,
      workspaceId: ids.workspace,
      branchId: ids.branchA,
      rootRequestId: ids.request,
      mode: 'direct',
      status: 'completed',
    });
    await connection.db.insert(toolCalls).values({
      id: ids.tool,
      runId: ids.run,
      toolId: 'workspace.search',
      toolVersion: '1.0.0',
      arguments: { query: 'evidence' },
      argumentsHash: 'sha256:arguments',
      risk: 'read_only',
      sideEffect: 'Reads evidence',
      status: 'awaiting_approval',
    });
    await connection.db.insert(approvals).values({
      id: ids.approval,
      toolCallId: ids.tool,
      requestedFromUserId: ids.user,
      toolVersion: '1.0.0',
      argumentsHash: 'sha256:arguments',
      displayedSideEffect: 'Reads evidence',
      estimatedCost: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    await connection.db.insert(evidenceRecords).values({
      id: ids.evidence,
      runId: ids.run,
      sourceType: 'workspace',
      title: 'Evidence',
      excerpt: 'Verified fact',
      sourceRevision: 'revision-1',
      contentHash: 'sha256:evidence',
      metadata: {},
    });
    await connection.db.insert(memoryCandidates).values({
      id: ids.memory,
      workspaceId: ids.workspace,
      userId: ids.user,
      sourceRunId: ids.run,
      sourceToolCallId: ids.tool,
      subject: 'style',
      value: 'concise',
      valueHash: 'sha256:concise',
      confidenceBps: 8_000,
    });
    await connection.db.insert(modelSelections).values({
      id: ids.modelSelection,
      runId: ids.run,
      purpose: 'main',
      policySnapshot: { provider: 'test' },
      selectedModel: 'test/model',
    });
    const skillMarkdown =
      '---\nid: protected-skill\nversion: 1.0.0\ndescription: Protected Skill\n---\nUse protected context.';
    await connection.db.insert(skillRevisions).values({
      id: ids.skillRevision,
      workspaceId: ids.workspace,
      skillId: 'protected-skill',
      version: '1.0.0',
      content: skillMarkdown,
      contentHash: 'sha256:protected-skill',
      allowedTools: [],
    });
    await connection.db.insert(runSkillBindings).values({
      runId: ids.run,
      skillRevisionId: ids.skillRevision,
      contentHash: 'sha256:protected-skill',
      allowedTools: [],
    });
    await connection.db.insert(mentionBindings).values({
      id: ids.mention,
      runId: ids.run,
      targetId: ids.article,
      targetKind: 'article',
      revision: ids.articleRevision,
      contentHash: 'sha256:article-revision',
      authorizedUserId: ids.user,
    });
    await connection.db.insert(artifacts).values({
      id: ids.artifact,
      runId: ids.run,
      type: 'ResearchBrief',
      title: 'Protected artifact',
      currentVersion: 1,
    });
    await connection.db.insert(artifactVersions).values({
      id: ids.artifactVersion,
      artifactId: ids.artifact,
      version: 1,
      summary: 'Protected version',
      content: { markdown: 'Fact' },
      contentHash: 'sha256:artifact-version',
    });
    await connection.db.insert(editProposals).values({
      id: ids.editProposal,
      articleId: ids.article,
      runId: ids.run,
      baseRevisionId: ids.articleRevision,
      operations: [],
      reviewMode: 'document',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await connection.db.insert(editProposalBatches).values({
      id: ids.editProposalBatch,
      proposalId: ids.editProposal,
      runId: ids.run,
      sourceToolCallId: ids.tool,
      batchNumber: 1,
      operations: [],
      diffs: [],
      beforeHash: 'sha256:before',
      afterHash: 'sha256:after',
    });
    await connection.db.insert(actionProposals).values({
      id: ids.actionProposal,
      sourceRunId: ids.run,
      articleId: ids.article,
      baseRevisionId: ids.articleRevision,
      requestedByUserId: ids.user,
      instruction: 'Revise the article',
      summary: 'Pending protected action',
      selectedBlocks: [],
      grantedCapabilities: ['article.propose'],
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('appends versions and links incremental summaries to the prior successful fact', async () => {
    const first = await appendConversationCompaction(connection.db, {
      id: randomUUID(),
      branchId: ids.branchA,
      reason: 'manual',
      sourceFromSequence: 1,
      sourceThroughSequence: 2,
      firstKeptMessageSequence: 3,
      summary: 'User requested the first draft.',
      shortSummary: 'First draft requested',
      tokensBefore: 1_000,
      tokenCount: 40,
      preserveData: { evidenceIds: ['evidence-1'] },
      model: 'provider/model',
      promptVersion: 'conversation-compaction@1',
      reserveTokens: 2_000,
      reserveProvenance: 'explicit',
    });
    const second = await appendConversationCompaction(connection.db, {
      id: randomUUID(),
      branchId: ids.branchA,
      reason: 'automatic',
      sourceFromSequence: 3,
      sourceThroughSequence: 4,
      firstKeptMessageSequence: 5,
      summary: 'The first draft was requested and evidence was reviewed.',
      tokensBefore: 1_400,
      tokenCount: 55,
      preserveData: { evidenceIds: ['evidence-1'], toolCallIds: ['tool-1'] },
      model: 'provider/model',
      promptVersion: 'conversation-compaction@1',
      reserveTokens: 2_000,
      reserveProvenance: 'explicit',
    });

    expect(first).toMatchObject({ version: 1, previousCompactionId: null, status: 'completed' });
    expect(second).toMatchObject({
      version: 2,
      previousCompactionId: first.id,
      status: 'completed',
    });
    expect(await getEffectiveConversationCompaction(connection.db, ids.branchA, 6)).toMatchObject({
      id: second.id,
      summary: second.summary,
    });
  });

  it('records failure without replacing the previous successful compaction', async () => {
    const before = await getEffectiveConversationCompaction(connection.db, ids.branchA, 6);
    const failed = await appendConversationCompaction(connection.db, {
      id: randomUUID(),
      branchId: ids.branchA,
      reason: 'mid_turn',
      sourceFromSequence: 5,
      sourceThroughSequence: 5,
      tokensBefore: 2_000,
      model: 'provider/model',
      promptVersion: 'conversation-compaction@1',
      reserveTokens: 2_000,
      reserveProvenance: 'explicit',
      failure: { code: 'empty_output', message: 'The model returned no summary', retryable: true },
    });

    expect(failed).toMatchObject({ status: 'failed', version: 3 });
    expect(await getEffectiveConversationCompaction(connection.db, ids.branchA, 6)).toMatchObject({
      id: before?.id,
    });
  });

  it('isolates sibling branches and rejects a keep boundary from another branch', async () => {
    expect(await getEffectiveConversationCompaction(connection.db, ids.branchB, 6)).toBeUndefined();
    await expect(
      appendConversationCompaction(connection.db, {
        id: randomUUID(),
        branchId: ids.branchB,
        reason: 'manual',
        sourceFromSequence: 1,
        sourceThroughSequence: 2,
        firstKeptMessageSequence: 99,
        summary: 'Invalid boundary',
        tokensBefore: 100,
        tokenCount: 10,
        preserveData: {},
        model: 'provider/model',
        promptVersion: 'conversation-compaction@1',
        reserveTokens: 20,
        reserveProvenance: 'explicit',
      }),
    ).rejects.toThrow('keep boundary');
  });

  it('collects protected PostgreSQL fact references for the summarized range', async () => {
    await expect(
      collectConversationCompactionPreserveData(connection.db, ids.branchA, 1),
    ).resolves.toMatchObject({
      runIds: [ids.run],
      toolCallIds: [ids.tool],
      unsettledToolCallIds: [ids.tool],
      pendingApprovalIds: [ids.approval],
      evidenceIds: [ids.evidence],
      memoryCandidateIds: [ids.memory],
      artifactIds: [ids.artifact],
      artifactVersionIds: [ids.artifactVersion],
      editProposalIds: [ids.editProposal],
      pendingEditProposalIds: [ids.editProposal],
      editProposalBatchIds: [ids.editProposalBatch],
      actionProposalIds: [ids.actionProposal],
      pendingActionProposalIds: [ids.actionProposal],
      articleRevisionIds: [ids.articleRevision],
      skillRevisionIds: [ids.skillRevision],
      modelSelectionIds: [ids.modelSelection],
      costRunIds: [ids.run],
    });
  });
});

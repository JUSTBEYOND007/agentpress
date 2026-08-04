import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PiRuntimeAdapter, type AgentRuntime } from '@agentpress/agent-runtime';
import { ProposalService, registerArticleTools } from '@agentpress/editor-application';
import { hashBlock } from '@agentpress/editor-patch';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import {
  agentSessions,
  agentTranscriptEntries,
  agentTasks,
  agentRuns,
  approvals,
  appUsers,
  artifacts,
  artifactVersions,
  articleRevisions,
  articles,
  connectDatabase,
  contextPacks,
  conversationBranches,
  conversationMessages,
  conversations,
  executionPlans,
  editProposals,
  planRevisions,
  rootRequests,
  runContextPacks,
  runDirectives,
  runEvents,
  runSkillBindings,
  skillRevisions,
  memoryCandidates,
  modelSelections,
  mentionBindings,
  queuedFollowups,
  taskResults,
  toolCalls,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { hashToolArguments, ToolRegistry } from '@agentpress/tool-runtime';
import { Type } from '@sinclair/typebox';
import { and, eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ActionProposalService,
  ContextGovernanceService,
  DirectRunService,
  PersistentToolBridge,
  runtimeToolName,
  ToolCallService,
  type LiveRunEvent,
  type RunEventPublisher,
} from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Direct Run application flow', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
    branch: randomUUID(),
    article: randomUUID(),
    articleRevision: randomUUID(),
    skillRevision: randomUUID(),
    memory: randomUUID(),
  };
  const published: LiveRunEvent[] = [];
  const publisher: RunEventPublisher = {
    publish(event) {
      published.push(event);
      return Promise.resolve();
    },
  };
  const runtime = PiRuntimeAdapter.forTests({
    responses: ['第一轮稳定回答。', '第二轮稳定回答。'],
  });
  const service = new DirectRunService({
    database: connection.db,
    publisher,
    runtimeFactory: { create: () => runtime },
    systemPrompt: 'You are AgentPress.',
  });
  const governance = new ContextGovernanceService(connection.db);

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Direct Run User',
    });
    await connection.db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Direct Run Workspace',
    });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Direct Run',
    });
    const articleDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'mention-block' },
          content: [{ type: 'text', text: 'Mentioned immutable content' }],
        },
      ],
    };
    const articleHash = createHash('sha256').update(JSON.stringify(articleDocument)).digest('hex');
    await connection.db
      .insert(articles)
      .values({ id: ids.article, workspaceId: ids.workspace, title: 'Mention target' });
    await connection.db.insert(articleRevisions).values({
      id: ids.articleRevision,
      articleId: ids.article,
      revisionNumber: 1,
      schemaVersion: 1,
      document: articleDocument,
      documentHash: articleHash,
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId: ids.articleRevision })
      .where(eq(articles.id, ids.article));
    const skillMarkdown =
      '---\nid: concise\nversion: 1.0.0\ndescription: Concise output\nallowedTools:\n  - article.read_current\n---\nKeep the answer concise.';
    await connection.db.insert(skillRevisions).values({
      id: ids.skillRevision,
      workspaceId: ids.workspace,
      skillId: 'concise',
      version: '1.0.0',
      content: skillMarkdown,
      contentHash: createHash('sha256').update(skillMarkdown).digest('hex'),
      allowedTools: ['article.read_current'],
    });
    await connection.db.insert(memoryCandidates).values({
      id: ids.memory,
      workspaceId: ids.workspace,
      userId: ids.user,
      subject: 'writing-style',
      value: 'Prefer short paragraphs',
      valueHash: createHash('sha256').update('Prefer short paragraphs').digest('hex'),
      confidenceBps: 9000,
      status: 'accepted',
    });
    await connection.db.insert(conversationBranches).values({
      id: ids.branch,
      conversationId: ids.conversation,
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('deduplicates creation and restores stable history for the next turn', async () => {
    const firstInput = {
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: '第一问',
      idempotencyKey: randomUUID(),
    };
    const first = await service.create(firstInput);
    const duplicate = await service.create(firstInput);

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ ...first, created: false });
    await expect(service.execute(first.runId)).resolves.toMatchObject({ status: 'completed' });

    const second = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: '第二问',
      idempotencyKey: randomUUID(),
    });
    await expect(service.execute(second.runId)).resolves.toMatchObject({ status: 'completed' });

    const messages = await connection.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.branchId, ids.branch));
    expect(messages).toHaveLength(4);
    expect(messages.every(({ stable }) => stable)).toBe(true);
    expect(
      await connection.db.select().from(rootRequests).where(eq(rootRequests.branchId, ids.branch)),
    ).toHaveLength(2);
    expect(
      await connection.db.select().from(runEvents).where(eq(runEvents.runId, second.runId)),
    ).toHaveLength(5);
    const selections = await connection.db
      .select({ purpose: modelSelections.purpose, selectedModel: modelSelections.selectedModel })
      .from(modelSelections)
      .where(eq(modelSelections.runId, second.runId));
    expect(selections).toHaveLength(1);
    expect(selections[0]?.purpose).toBe('main');
    expect(typeof selections[0]?.selectedModel).toBe('string');
    expect(selections[0]?.selectedModel).not.toBe('main');
    expect(published.some((event) => !event.durable)).toBe(true);
  });

  it('rejects unauthorized, missing, and stale context bindings before creating a Run', async () => {
    const otherWorkspaceId = randomUUID();
    const otherArticleId = randomUUID();
    const otherRevisionId = randomUUID();
    const otherDocument = { type: 'doc', content: [] };
    await connection.db.insert(workspaces).values({
      id: otherWorkspaceId,
      name: 'Other Workspace',
    });
    await connection.db.insert(articles).values({
      id: otherArticleId,
      workspaceId: otherWorkspaceId,
      title: 'Private article',
    });
    await connection.db.insert(articleRevisions).values({
      id: otherRevisionId,
      articleId: otherArticleId,
      revisionNumber: 1,
      schemaVersion: 1,
      document: otherDocument,
      documentHash: createHash('sha256').update(JSON.stringify(otherDocument)).digest('hex'),
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId: otherRevisionId })
      .where(eq(articles.id, otherArticleId));

    const base = {
      conversationId: ids.conversation,
      branchId: ids.branch,
      userId: ids.user,
      prompt: '读取上下文',
    };
    const runsBefore = await connection.db.select({ id: agentRuns.id }).from(agentRuns);
    const unauthorizedBindings = [
      [{ type: 'mention' as const, targetId: otherArticleId }],
      [{ type: 'attachment' as const, attachmentId: randomUUID() }],
      [{ type: 'evidence' as const, evidenceId: randomUUID() }],
      [{ type: 'skill' as const, skillId: 'missing', version: '1.0.0' }],
    ];
    for (const contextBindings of unauthorizedBindings) {
      await expect(
        service.create({ ...base, idempotencyKey: randomUUID(), contextBindings }),
      ).rejects.toMatchObject({ code: 'unauthorized_context' });
    }
    await expect(
      service.create({
        ...base,
        idempotencyKey: randomUUID(),
        contextBindings: [
          {
            type: 'article_selection',
            articleId: ids.article,
            revisionId: ids.articleRevision,
            blocks: [{ blockId: 'mention-block', contentHash: 'stale-hash' }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_context' });

    const runsAfter = await connection.db.select({ id: agentRuns.id }).from(agentRuns);
    expect(runsAfter).toHaveLength(runsBefore.length);
  });

  it('settles an unexpected runtime initialization error instead of leaving the Run active', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      title: 'Runtime failure',
    });
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    const failedService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: () => {
          throw new Error('Runtime model is not configured');
        },
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await failedService.create({
      conversationId,
      branchId,
      userId: ids.user,
      prompt: '你好',
      idempotencyKey: randomUUID(),
    });

    await expect(failedService.execute(run.runId)).resolves.toEqual({
      runId: run.runId,
      status: 'failed',
    });
    const rows = await connection.db
      .select({ status: agentRuns.status, finalOutcome: agentRuns.finalOutcome })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    expect(rows[0]).toMatchObject({
      status: 'failed',
      finalOutcome: {
        error: {
          code: 'runtime_error',
          message: 'Runtime model is not configured',
          retryable: false,
        },
      },
    });
    const events = await connection.db
      .select({ eventType: runEvents.eventType })
      .from(runEvents)
      .where(eq(runEvents.runId, run.runId));
    expect(events.at(-1)?.eventType).toBe('run.failed');
  });

  it('settles an invalid persisted root message instead of blocking later commands', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      title: 'Invalid persisted request',
    });
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    const run = await service.create({
      conversationId,
      branchId,
      userId: ids.user,
      prompt: '你好',
      idempotencyKey: randomUUID(),
    });
    await connection.db
      .update(conversationMessages)
      .set({ content: [{ type: 'legacy-message' }] })
      .where(eq(conversationMessages.id, run.messageId));

    await expect(service.execute(run.runId)).resolves.toEqual({
      runId: run.runId,
      status: 'failed',
    });
    const rows = await connection.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    expect(rows[0]?.status).toBe('failed');
    const events = await connection.db
      .select({ eventType: runEvents.eventType })
      .from(runEvents)
      .where(eq(runEvents.runId, run.runId));
    expect(events.at(-1)?.eventType).toBe('run.failed');
  });

  it('leaves an aborted worker attempt recoverable instead of committing a business failure', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      title: 'Interrupted worker',
    });
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    const interruptedService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: () => ({
          execute: () => Promise.reject(new Error('Worker is shutting down')),
        }),
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await interruptedService.create({
      conversationId,
      branchId,
      userId: ids.user,
      prompt: '继续执行',
      idempotencyKey: randomUUID(),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(interruptedService.execute(run.runId, controller.signal)).rejects.toThrow();
    const rows = await connection.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    expect(rows[0]?.status).toBe('running');
    const events = await connection.db
      .select({ eventType: runEvents.eventType })
      .from(runEvents)
      .where(eq(runEvents.runId, run.runId));
    expect(events.some(({ eventType }) => eventType === 'run.failed')).toBe(false);
  });

  it('creates button runs only from a server-built confirmed action envelope', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    const proposalId = randomUUID();
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      articleId: ids.article,
      title: 'Confirmed edit',
    });
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    const run = await service.createConfirmedAction({
      conversationId,
      branchId,
      userId: ids.user,
      proposalId,
      instruction: '继续上一段',
      articleId: ids.article,
      baseRevisionId: ids.articleRevision,
      selectedBlocks: [],
      grantedCapabilities: ['article.read', 'article.propose'],
    });
    const rows = await connection.db
      .select({ actionEnvelope: rootRequests.actionEnvelope })
      .from(rootRequests)
      .where(eq(rootRequests.id, run.rootRequestId));
    expect(rows[0]?.actionEnvelope).toMatchObject({
      source: 'button',
      actionProposalId: proposalId,
      payload: { instruction: '继续上一段', articleId: ids.article },
      grantedCapabilities: ['article.read', 'article.propose'],
    });
    const bindings = await connection.db
      .select({ targetId: mentionBindings.targetId, revision: mentionBindings.revision })
      .from(mentionBindings)
      .where(eq(mentionBindings.runId, run.runId));
    expect(bindings).toEqual([{ targetId: ids.article, revision: ids.articleRevision }]);
  });

  it('lets Main create a reviewable article draft without a plan or confirmation run', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      articleId: ids.article,
      title: 'Direct article editing',
    });
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    const registry = new ToolRegistry();
    registerArticleTools(registry, connection.db, new ProposalService(connection.db));
    const toolCallsService = new ToolCallService({
      database: connection.db,
      publisher,
      registry,
    });
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: toolCallsService,
    });
    const editRuntime = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse(runtimeToolName('article.propose_edits', '1.0.0'), {
          operations: [
            {
              operationId: 'main-replace',
              kind: 'replace',
              blockId: 'mention-block',
              expectedHash: hashBlock({
                type: 'paragraph',
                attrs: { blockId: 'mention-block' },
                content: [{ type: 'text', text: 'Mentioned immutable content' }],
              }),
              block: {
                type: 'paragraph',
                attrs: { blockId: 'mention-block' },
                content: [{ type: 'text', text: 'Main edited content' }],
              },
            },
          ],
        }),
      ],
    });
    const directEditService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => editRuntime },
      runtimeToolFactory: bridge,
      systemPrompt: 'You are AgentPress.',
    });
    const run = await directEditService.create({
      conversationId,
      branchId,
      userId: ids.user,
      prompt: '把正文改得更直接',
      idempotencyKey: randomUUID(),
    });

    await expect(directEditService.execute(run.runId)).resolves.toEqual({
      runId: run.runId,
      status: 'completed',
    });
    const [proposals, plans, bindings] = await Promise.all([
      connection.db.select().from(editProposals).where(eq(editProposals.runId, run.runId)),
      connection.db.select().from(executionPlans).where(eq(executionPlans.runId, run.runId)),
      connection.db.select().from(mentionBindings).where(eq(mentionBindings.runId, run.runId)),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.status).toBe('pending');
    expect(plans).toHaveLength(0);
    expect(bindings).toMatchObject([{ targetId: ids.article }]);
    const projection = await directEditService.getProjection(run.runId);
    const executionPart = projection?.parts.find(({ type }) => type === 'usage');
    const executions = Array.isArray(executionPart?.payload.executions)
      ? executionPart.payload.executions
      : [];
    expect(projection?.status).toBe('completed');
    expect(executionPart?.status).toBe('execution.facts');
    expect(executions).toMatchObject([
      {
        purpose: 'main',
        provider: 'faux',
        model: 'faux-1',
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
      },
    ]);
  });

  it('loads only the requested persisted artifact version for its owning Run', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const run = await service.create({
      conversationId: ids.conversation,
      branchId,
      userId: ids.user,
      prompt: '生成报告',
      idempotencyKey: randomUUID(),
    });
    const artifactId = randomUUID();
    await connection.db.insert(artifacts).values({
      id: artifactId,
      runId: run.runId,
      type: 'ResearchBrief',
      title: '持久化报告',
      currentVersion: 1,
    });
    await connection.db.insert(artifactVersions).values({
      id: randomUUID(),
      artifactId,
      version: 1,
      summary: '版本一',
      content: { markdown: '# 报告' },
      contentHash: createHash('sha256')
        .update(JSON.stringify({ markdown: '# 报告' }))
        .digest('hex'),
    });

    await expect(service.getArtifact(run.runId, artifactId, 1)).resolves.toMatchObject({
      status: 'found',
      artifact: { id: artifactId, version: 1, summary: '版本一' },
    });
    const projection = await service.getProjection(run.runId);
    expect(projection?.artifacts).toEqual([
      {
        id: artifactId,
        type: 'ResearchBrief',
        title: '持久化报告',
        version: 1,
        summary: '版本一',
      },
    ]);
    expect(projection?.parts.find(({ type }) => type === 'artifact')?.payload).not.toHaveProperty(
      'content',
    );
    await expect(service.getArtifact(run.runId, artifactId, 2)).resolves.toEqual({
      status: 'stale',
      currentVersion: 1,
    });
    await expect(service.getArtifact(run.runId, randomUUID(), 1)).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('confirms a persisted action proposal idempotently into one authorized run', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      articleId: ids.article,
      title: 'Action proposal',
    });
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    const source = await service.create({
      conversationId,
      branchId,
      userId: ids.user,
      prompt: '继续上一段',
      idempotencyKey: randomUUID(),
      mentionTargetIds: [ids.article],
    });
    await connection.db
      .update(agentRuns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(agentRuns.id, source.runId));
    const actions = new ActionProposalService(connection.db, publisher);
    const proposal = await actions.create({
      runId: source.runId,
      instruction: '继续上一段',
      summary: '继续写作',
      selectedBlocks: [],
    });
    const confirmed = await actions.confirm(proposal.id, ids.user, service);
    const replay = await actions.confirm(proposal.id, ids.user, service);
    expect(confirmed).toMatchObject({ status: 'confirmed' });
    expect(replay.confirmedRunId).toBe(confirmed.confirmedRunId);
    const confirmedRuns = await connection.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.branchId, branchId));
    expect(confirmedRuns).toHaveLength(2);
  });

  it('pins Mention, Skill, prompt and accepted memory into an immutable Context Manifest', async () => {
    const run = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: 'Use the selected context',
      idempotencyKey: randomUUID(),
      mentionTargetIds: [ids.article],
      skills: [{ skillId: 'concise', version: '1.0.0' }],
    });
    const [packs, mentions, skills] = await Promise.all([
      connection.db.select().from(runContextPacks).where(eq(runContextPacks.runId, run.runId)),
      connection.db.select().from(mentionBindings).where(eq(mentionBindings.runId, run.runId)),
      connection.db.select().from(runSkillBindings).where(eq(runSkillBindings.runId, run.runId)),
    ]);
    expect(mentions[0]).toMatchObject({
      targetId: ids.article,
      revision: ids.articleRevision,
    });
    expect(skills[0]).toMatchObject({
      skillRevisionId: ids.skillRevision,
      allowedTools: ['article.read_current'],
    });
    expect(packs[0]?.content).toContain('Mentioned immutable content');
    expect(packs[0]?.content).toContain('Keep the answer concise.');
    expect(packs[0]?.content).toContain('Prefer short paragraphs');
    const manifest = packs[0]?.manifest as { readonly skillVersions?: unknown } | undefined;
    const skillVersions = manifest?.skillVersions as Record<string, unknown> | undefined;
    expect(skillVersions?.concise).toEqual(expect.stringMatching(/^1\.0\.0:/u));
    await expect(service.getProjection(run.runId)).resolves.toMatchObject({
      context: {
        manifest: {
          included: expect.arrayContaining([
            expect.objectContaining({ id: `article:${ids.article}`, kind: 'mention' }),
            expect.objectContaining({ id: 'skill:concise', kind: 'policy' }),
          ]) as unknown,
        },
        contextHash: packs[0]?.contentHash,
      },
    });
    await service.requestCancellation(run.runId);
    await service.execute(run.runId);
  });

  it('binds a regenerated Run to the copied fork message without duplicating the user turn', async () => {
    const branchId = randomUUID();
    const messageId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
      parentBranchId: ids.branch,
    });
    await connection.db.insert(conversationMessages).values({
      id: messageId,
      branchId,
      role: 'user',
      sequence: 1,
      content: [
        {
          type: 'agentpress.runtime-message',
          version: 1,
          message: { role: 'user', content: '重新回答这条消息', timestamp: Date.now() },
        },
      ],
      stable: true,
    });

    const run = await service.create({
      conversationId: ids.conversation,
      branchId,
      userId: ids.user,
      prompt: '重新回答这条消息',
      existingMessageId: messageId,
      idempotencyKey: randomUUID(),
    });

    expect(run.messageId).toBe(messageId);
    await expect(
      connection.db
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(eq(conversationMessages.branchId, branchId)),
    ).resolves.toHaveLength(1);
  });

  it('forks at the exact stable message boundary and rejects unauthorized branch access', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    const outsiderId = randomUUID();
    await connection.db.insert(appUsers).values({
      id: outsiderId,
      logtoSubject: `logto|${outsiderId}`,
      displayName: 'Outsider',
    });
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      title: 'Fork contract',
    });
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    const source = await service.create({
      conversationId,
      branchId,
      userId: ids.user,
      prompt: '分支根消息',
      idempotencyKey: randomUUID(),
    });
    await connection.db.insert(conversationMessages).values({
      id: randomUUID(),
      branchId,
      role: 'assistant',
      sequence: 2,
      content: [
        {
          type: 'agentpress.runtime-message',
          version: 1,
          message: { role: 'assistant', content: '不应被复制', timestamp: Date.now() },
        },
      ],
      stable: true,
    });

    const fork = await service.forkBranch(conversationId, branchId, source.messageId, ids.user);
    expect(fork).toMatchObject({
      parentBranchId: branchId,
      forkedFromMessageId: source.messageId,
    });
    const copied = await connection.db
      .select({ id: conversationMessages.id, role: conversationMessages.role })
      .from(conversationMessages)
      .where(eq(conversationMessages.branchId, fork.branchId));
    expect(copied).toEqual([{ id: fork.forkedMessageId, role: 'user' }]);

    await expect(
      service.forkBranch(conversationId, branchId, source.messageId, outsiderId),
    ).rejects.toMatchObject({ code: 'branch_not_found' });
    await expect(
      service.forkBranch(randomUUID(), branchId, source.messageId, ids.user),
    ).rejects.toMatchObject({ code: 'branch_not_found' });
  });

  it('versions declarative Skills and requires confirmation before recalling Agent memory', async () => {
    const markdown =
      '---\nid: fact-check\nversion: 2.0.0\ndescription: Verify facts\nallowedTools:\n  - web_research.search\n---\nRequire evidence for factual claims.';
    await expect(governance.createSkill(ids.workspace, markdown)).resolves.toMatchObject({
      skillId: 'fact-check',
      version: '2.0.0',
      allowedTools: ['web_research.search'],
    });
    const runs = await connection.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.workspaceId, ids.workspace));
    const candidate = await governance.proposeMemoryForRun(
      runs[0]?.id ?? '',
      'tone',
      'Use a neutral tone',
      0.95,
    );
    expect(candidate.status).toBe('pending');
    await expect(
      governance.decideMemory(ids.workspace, ids.user, candidate.id, 'accepted'),
    ).resolves.toMatchObject({ status: 'accepted' });
  });

  it('persists cancellation before aborting Pi and reaches a terminal state', async () => {
    const cancellationBranch = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: cancellationBranch,
      conversationId: ids.conversation,
    });
    const controller = new AbortController();
    const serviceReference: { current?: DirectRunService } = {};
    let cancellationRequested = false;
    const cancellationPublisher: RunEventPublisher = {
      async publish(event) {
        if (!event.durable && event.event.type === 'content.delta' && !cancellationRequested) {
          cancellationRequested = true;
          const first = await serviceReference.current?.requestCancellation(event.runId);
          const repeated = await serviceReference.current?.requestCancellation(event.runId);
          expect(first).toMatchObject({ outcome: 'accepted', status: 'cancelling' });
          expect(repeated).toMatchObject({ outcome: 'accepted', status: 'cancelling' });
          controller.abort();
        }
      },
    };
    const cancellationService = new DirectRunService({
      database: connection.db,
      publisher: cancellationPublisher,
      runtimeFactory: {
        create: () =>
          PiRuntimeAdapter.forTests({
            responses: ['不会完整生成的回答。'],
            tokensPerSecond: 1,
          }),
      },
      systemPrompt: 'You are AgentPress.',
    });
    serviceReference.current = cancellationService;
    const run = await cancellationService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: cancellationBranch,
      prompt: '开始取消测试',
      idempotencyKey: randomUUID(),
    });
    const queued = await cancellationService.enqueueFollowUp(run.runId, '取消后不应继续');

    await expect(cancellationService.execute(run.runId, controller.signal)).resolves.toMatchObject({
      status: 'cancelled',
    });
    const rows = await connection.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    expect(rows[0]?.status).toBe('cancelled');
    const userMessages = await connection.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.branchId, cancellationBranch),
          eq(conversationMessages.role, 'user'),
        ),
      );
    expect(userMessages).toHaveLength(1);
    const followUps = await connection.db
      .select({ status: queuedFollowups.status })
      .from(queuedFollowups)
      .where(eq(queuedFollowups.id, queued.directiveId));
    expect(followUps).toEqual([{ status: 'cancelled' }]);
    const branchRuns = await connection.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.branchId, cancellationBranch));
    expect(branchRuns).toHaveLength(1);
  });

  it('persists and executes a five-Specialist DAG with isolated Context Packs', async () => {
    const plannedBranch = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: plannedBranch,
      conversationId: ids.conversation,
    });
    const tasks = [
      plannedTask('research', 'researcher'),
      plannedTask('write', 'writer', ['research']),
      plannedTask('edit', 'editor', ['write']),
      plannedTask('verify', 'fact_checker', ['edit']),
      plannedTask('illustrate', 'illustrator', ['verify'], 'optional'),
    ];
    const plannedRuntime = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', { goal: 'Produce a verified illustrated article', tasks }),
        ...tasks.map((task) => taskCompleteResponse(`${task.owner} completed`)),
        runCompleteResponse('最终综合文章'),
      ],
    });
    const plannedService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => plannedRuntime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await plannedService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: plannedBranch,
      prompt: '联网搜索最新资料并写一篇图文文章',
      idempotencyKey: randomUUID(),
    });

    expect(run.mode).toBe('direct');
    await expect(plannedService.execute(run.runId)).resolves.toMatchObject({
      status: 'completed',
    });

    const persistedTasks = await connection.db
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.runId, run.runId));
    expect(persistedTasks).toHaveLength(5);
    expect(new Set(persistedTasks.map(({ owner }) => owner))).toEqual(
      new Set(['researcher', 'writer', 'editor', 'fact_checker', 'illustrator']),
    );
    expect(persistedTasks.every(({ status }) => status === 'succeeded')).toBe(true);
    const revisions = await connection.db
      .select({ revisionNumber: planRevisions.revisionNumber })
      .from(planRevisions)
      .innerJoin(executionPlans, eq(executionPlans.id, planRevisions.planId))
      .where(eq(executionPlans.runId, run.runId));
    expect(revisions.map(({ revisionNumber }) => revisionNumber)).toEqual([1]);
    const contexts = await connection.db
      .select()
      .from(contextPacks)
      .where(
        inArray(
          contextPacks.taskId,
          persistedTasks.map(({ id }) => id),
        ),
      );
    expect(contexts).toHaveLength(5);
    expect(
      contexts.every(
        ({ content, contentHash, format, schemaVersion, manifest }) =>
          content.length > 0 &&
          contentHash.length > 0 &&
          format === 'json' &&
          schemaVersion === 1 &&
          typeof manifest.taskId === 'string' &&
          Array.isArray(manifest.capabilities),
      ),
    ).toBe(true);
    const results = await connection.db.select().from(taskResults);
    expect(
      results.filter(({ taskId }) => persistedTasks.some(({ id }) => id === taskId)),
    ).toHaveLength(5);
    const events = await connection.db
      .select({ eventType: runEvents.eventType })
      .from(runEvents)
      .where(eq(runEvents.runId, run.runId));
    expect(events.filter(({ eventType }) => eventType === 'plan.revised')).toHaveLength(1);
  });

  it('repairs a failed Specialist protocol twice before accepting task_complete', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const task = plannedTask('repairable', 'writer');
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', { goal: 'Repair specialist completion', tasks: [task] }),
        fauxAssistantMessage([fauxToolCall('task_complete', { status: 'invalid' })], {
          stopReason: 'toolUse',
        }),
        taskCompleteResponse('Recovered after protocol repair'),
        runCompleteResponse('协议修复后完成。'),
      ],
    });
    const repairService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await repairService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '执行需要协议修复的任务',
      idempotencyKey: randomUUID(),
    });

    await expect(repairService.execute(run.runId)).resolves.toMatchObject({ status: 'completed' });
    const sessions = await connection.db
      .select({ logicalKey: agentSessions.logicalKey, status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.runId, run.runId));
    expect(sessions.some(({ logicalKey }) => logicalKey.endsWith(':2'))).toBe(true);
  });

  it('persists and can cancel Steering while a Direct Run is still active', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const run = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '你好',
      idempotencyKey: randomUUID(),
    });

    const directive = await service.enqueueSteering(run.runId, '改变方向');
    await expect(service.getProjection(run.runId)).resolves.toMatchObject({
      pendingDirectives: [
        {
          id: directive.directiveId,
          kind: 'steering',
          content: '改变方向',
          sequence: 1,
        },
      ],
    });
    await expect(service.cancelSteering(run.runId, directive.directiveId)).resolves.toBe(true);
    await expect(service.cancelSteering(run.runId, directive.directiveId)).resolves.toBe(false);
    await expect(service.getProjection(run.runId)).resolves.toMatchObject({
      pendingDirectives: [],
    });
  });

  it('fails the Run when a Required Specialist fails', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', {
          goal: 'Research the subject',
          tasks: [plannedTask('research', 'researcher')],
        }),
        taskCompleteResponse('Research unavailable', 'failed'),
      ],
    });
    const requiredFailureService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await requiredFailureService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '联网搜索资料并写一篇文章',
      idempotencyKey: randomUUID(),
    });

    await expect(requiredFailureService.execute(run.runId)).resolves.toMatchObject({
      status: 'failed',
    });
    const rows = await connection.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    expect(rows[0]?.status).toBe('failed');
  });

  it('persists cancellation for running and pending Planned tasks', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const controller = new AbortController();
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', {
          goal: 'Research and write',
          tasks: [plannedTask('research', 'researcher')],
        }),
        '不会完成的 Specialist 输出',
      ],
    });
    let runId = '';
    let cancellationRequested = false;
    const cancellationPublisher: RunEventPublisher = {
      async publish(event) {
        if (event.durable && event.event.eventType === 'task.started' && !cancellationRequested) {
          cancellationRequested = true;
          await cancellationService.requestCancellation(runId);
          controller.abort();
        }
      },
    };
    const cancellationService = new DirectRunService({
      database: connection.db,
      publisher: cancellationPublisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await cancellationService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '联网搜索资料并写一篇图文文章',
      idempotencyKey: randomUUID(),
    });
    runId = run.runId;

    await expect(cancellationService.execute(run.runId, controller.signal)).resolves.toMatchObject({
      status: 'cancelled',
    });
    const tasks = await connection.db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.runId, run.runId));
    expect(tasks).toHaveLength(1);
    expect(tasks.every(({ status }) => status === 'cancelled')).toBe(true);
  });

  it('recovers a Planned Run without fabricating a replacement revision', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const recoveryService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: () => {
          throw new Error('Preparing recovery must not invoke Pi');
        },
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await recoveryService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '联网搜索资料并写一篇图文文章',
      idempotencyKey: randomUUID(),
    });
    const planId = randomUUID();
    const revisionId = randomUUID();
    await connection.db.insert(executionPlans).values({ id: planId, runId: run.runId });
    await connection.db.insert(planRevisions).values({
      id: revisionId,
      planId,
      revisionNumber: 1,
      reason: 'initial_plan',
      summary: 'Interrupted plan',
    });
    await connection.db
      .update(agentRuns)
      .set({ status: 'running', activePlanRevisionId: revisionId })
      .where(eq(agentRuns.id, run.runId));

    await expect(recoveryService.prepareRecovery(run.runId)).resolves.toBe(true);
    const recoveredRuns = await connection.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    expect(recoveredRuns[0]?.status).toBe('recovering');
    const revisions = await connection.db
      .select({ reason: planRevisions.reason })
      .from(planRevisions)
      .where(eq(planRevisions.planId, planId));
    expect(revisions.map(({ reason }) => reason)).toEqual(['initial_plan']);
  });

  it('reuses a persisted logical Main Session and appends transcript sequences', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const recoveryService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: () => PiRuntimeAdapter.forTests({ responses: ['恢复后的直接回答。'] }),
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await recoveryService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '继续上次直接回答',
      idempotencyKey: randomUUID(),
    });
    const sessionId = randomUUID();
    await connection.db.insert(agentSessions).values({
      id: sessionId,
      runId: run.runId,
      kind: 'main',
      attempt: 1,
      logicalKey: `${run.runId}:main:1`,
      model: 'main',
      status: 'failed',
      nextSequence: 1,
    });
    await connection.db.insert(agentTranscriptEntries).values({
      id: randomUUID(),
      sessionId,
      sequence: 1,
      role: 'system',
      messageType: 'system_prompt',
      content: { content: 'Persisted before worker loss' },
    });
    await connection.db
      .update(agentRuns)
      .set({ status: 'recovering' })
      .where(eq(agentRuns.id, run.runId));

    await expect(recoveryService.execute(run.runId)).resolves.toMatchObject({
      status: 'completed',
    });
    const sessions = await connection.db
      .select({ id: agentSessions.id, nextSequence: agentSessions.nextSequence })
      .from(agentSessions)
      .where(eq(agentSessions.logicalKey, `${run.runId}:main:1`));
    expect(sessions).toEqual([{ id: sessionId, nextSequence: 5 }]);
    const entries = await connection.db
      .select({ sequence: agentTranscriptEntries.sequence })
      .from(agentTranscriptEntries)
      .where(eq(agentTranscriptEntries.sessionId, sessionId));
    expect(entries.map(({ sequence }) => sequence).sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('resumes an approved provider Tool Call and continues the real Pi transcript', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const registry = new ToolRegistry();
    let sideEffects = 0;
    registry.register({
      toolId: 'article.apply_proposal',
      version: '1.0.0',
      owner: 'article',
      description: 'Apply an immutable article proposal',
      capabilities: ['article.propose'],
      inputSchema: Type.Object(
        { proposalId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      outputSchema: Type.Object(
        { applied: Type.Boolean(), proposalId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      risk: 'external_write',
      sideEffect: 'Apply the selected immutable proposal',
      idempotency: 'provider_key',
      timeoutMs: 1_000,
      estimateCost: () => ({ credits: 1 }),
      execute: ({ proposalId }) => {
        sideEffects += 1;
        return Promise.resolve({ applied: true, proposalId });
      },
    });
    const toolService = new ToolCallService({ database: connection.db, registry, publisher });
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: toolService,
    });
    const recoveryService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: () =>
          PiRuntimeAdapter.forTests({
            responses: [
              taskCompleteResponse('Proposal applied after approval recovery'),
              runCompleteResponse('恢复后已完成文章修改。'),
            ],
          }),
      },
      runtimeToolFactory: bridge,
      systemPrompt: 'You are AgentPress.',
    });
    const run = await recoveryService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '应用已准备好的文章修改提案',
      idempotencyKey: randomUUID(),
    });
    const planId = randomUUID();
    const revisionId = randomUUID();
    const taskId = randomUUID();
    await connection.db.insert(executionPlans).values({ id: planId, runId: run.runId });
    await connection.db.insert(planRevisions).values({
      id: revisionId,
      planId,
      revisionNumber: 1,
      reason: 'main_agent',
      summary: 'Apply the approved proposal',
    });
    await connection.db.insert(agentTasks).values({
      id: taskId,
      runId: run.runId,
      planRevisionId: revisionId,
      objective: 'Apply the immutable article proposal',
      criticality: 'required',
      owner: 'writer',
      acceptanceCriteria: ['The exact approved proposal is applied once'],
      outputSchema: {},
      toolPolicy: { capabilities: ['article.propose'] },
      budget: { maxAttempts: 3, protocolRepairTurns: 2 },
      status: 'running',
      attempt: 1,
      maxAttempts: 3,
    });
    await connection.db
      .update(agentRuns)
      .set({ mode: 'planned', status: 'running', activePlanRevisionId: revisionId })
      .where(eq(agentRuns.id, run.runId));

    const providerToolCallId = 'provider-approval-recovery';
    const proposalId = randomUUID();
    const toolName = runtimeToolName('article.apply_proposal', '1.0.0');
    const assistant = {
      role: 'assistant' as const,
      content: '',
      blocks: [
        {
          type: 'tool_call' as const,
          id: providerToolCallId,
          name: toolName,
          arguments: { proposalId },
        },
      ],
      provider: 'faux',
      model: 'faux-model',
      stopReason: 'tool_use' as const,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
        costUsd: 0,
      },
      timestamp: Date.now(),
    };
    const interruptedSessionId = randomUUID();
    await connection.db.insert(agentSessions).values({
      id: interruptedSessionId,
      runId: run.runId,
      taskId,
      kind: 'specialist',
      attempt: 1,
      logicalKey: `${run.runId}:task:${taskId}:1`,
      model: 'writer',
      status: 'failed',
    });
    await connection.db.insert(agentTranscriptEntries).values({
      id: randomUUID(),
      sessionId: interruptedSessionId,
      sequence: 1,
      role: 'assistant',
      messageType: 'message',
      content: { message: assistant },
      providerToolCallId,
    });

    const proposal = await toolService.propose({
      runId: run.runId,
      taskId,
      providerToolCallId,
      toolId: 'article.apply_proposal',
      toolVersion: '1.0.0',
      arguments: { proposalId },
      requestedFromUserId: ids.user,
      allowedCapabilities: new Set(['article.propose']),
      idempotencyKey: `pi:${hashToolArguments({ runId: run.runId, providerToolCallId })}`,
    });
    expect(proposal.status).toBe('awaiting_approval');
    await toolService.decideApproval({
      toolCallId: proposal.toolCallId,
      decision: 'approved',
      userId: ids.user,
    });

    await expect(recoveryService.prepareRecovery(run.runId)).resolves.toBe(true);
    await expect(recoveryService.execute(run.runId)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(
      bridge.resumeApprovedToolCall(run.runId, taskId, providerToolCallId),
    ).resolves.toMatchObject({
      toolCallId: providerToolCallId,
      isError: false,
    });
    expect(sideEffects).toBe(1);
    const persistedCalls = await connection.db
      .select({
        providerToolCallId: toolCalls.providerToolCallId,
        status: toolCalls.status,
        output: toolCalls.output,
      })
      .from(toolCalls)
      .where(eq(toolCalls.id, proposal.toolCallId));
    expect(persistedCalls[0]).toMatchObject({
      providerToolCallId,
      status: 'succeeded',
      output: { applied: true, proposalId },
    });
    const approvalRows = await connection.db
      .select({ decision: approvals.decision })
      .from(approvals)
      .where(eq(approvals.toolCallId, proposal.toolCallId));
    expect(approvalRows).toEqual([{ decision: 'approved' }]);
    const recoveredTranscript = await connection.db
      .select({ role: agentTranscriptEntries.role, content: agentTranscriptEntries.content })
      .from(agentTranscriptEntries)
      .innerJoin(agentSessions, eq(agentSessions.id, agentTranscriptEntries.sessionId))
      .where(eq(agentSessions.taskId, taskId));
    expect(
      recoveredTranscript.some(
        ({ role, content }) =>
          role === 'tool' &&
          'message' in content &&
          (content.message as { toolCallId?: string }).toolCallId === providerToolCallId,
      ),
    ).toBe(true);
  });

  it('finishes with degradation when only an Optional Specialist fails', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', {
          goal: 'Write and illustrate',
          tasks: [
            plannedTask('write', 'writer'),
            plannedTask('illustrate', 'illustrator', ['write'], 'optional'),
          ],
        }),
        taskCompleteResponse('Draft completed'),
        taskCompleteResponse('Image provider unavailable', 'failed'),
        runCompleteResponse('无配图降级交付'),
      ],
    });
    const degradedService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await degradedService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '写一篇带配图的文章',
      idempotencyKey: randomUUID(),
    });

    await expect(degradedService.execute(run.runId)).resolves.toMatchObject({
      status: 'completed_with_degradation',
    });
    const rows = await connection.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    expect(rows[0]?.status).toBe('completed_with_degradation');
  });

  it('promotes Follow-ups in FIFO order across chained Runs', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const runtime: AgentRuntime = {
      execute(request) {
        return Promise.resolve({
          status: 'completed',
          messages: [assistantMessage(request.runId)],
        });
      },
    };
    let nextRunVisibleAtTerminal = false;
    let observedRootRunId = '';
    const followUpPublisher: RunEventPublisher = {
      async publish(event) {
        if (
          event.durable &&
          event.event.runId === observedRootRunId &&
          event.event.eventType === 'run.completed'
        ) {
          const visibleRuns = await connection.db
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(eq(agentRuns.branchId, branchId));
          nextRunVisibleAtTerminal = visibleRuns.some(({ id }) => id !== run.runId);
        }
      },
    };
    const followUpService = new DirectRunService({
      database: connection.db,
      publisher: followUpPublisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await followUpService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '你好',
      idempotencyKey: randomUUID(),
    });
    observedRootRunId = run.runId;
    const firstDirective = await followUpService.enqueueFollowUp(run.runId, '继续补充');
    const secondDirective = await followUpService.enqueueFollowUp(run.runId, '再给一个例子');
    await expect(followUpService.getProjection(run.runId)).resolves.toMatchObject({
      pendingDirectives: [
        {
          id: firstDirective.directiveId,
          kind: 'follow_up',
          content: '继续补充',
          sequence: 1,
        },
        {
          id: secondDirective.directiveId,
          kind: 'follow_up',
          content: '再给一个例子',
          sequence: 2,
        },
      ],
    });
    await followUpService.execute(run.runId);
    expect(nextRunVisibleAtTerminal).toBe(true);

    const queuedRuns = await connection.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.branchId, branchId));
    const nextRun = queuedRuns.find(({ id }) => id !== run.runId);
    expect(nextRun).toBeDefined();
    await followUpService.execute(nextRun?.id ?? '');

    const branchRuns = await connection.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.branchId, branchId));
    expect(branchRuns.map(({ status }) => status).sort()).toEqual([
      'completed',
      'completed',
      'queued',
    ]);
    const directiveRows = await connection.db
      .select({ id: runDirectives.id, status: runDirectives.status })
      .from(runDirectives)
      .where(inArray(runDirectives.id, [firstDirective.directiveId, secondDirective.directiveId]));
    expect(directiveRows.every(({ status }) => status === 'consumed')).toBe(true);
  });
});

function assistantMessage(seed: string) {
  return assistantMessageWithContent(seed, `result:${seed}`);
}

function assistantMessageWithContent(seed: string, content: string) {
  return {
    role: 'assistant' as const,
    content,
    provider: 'test',
    model: 'test',
    stopReason: 'stop' as const,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      costUsd: 0,
    },
    timestamp: Date.now(),
  };
}

function plannedTask(
  clientKey: string,
  owner: 'researcher' | 'writer' | 'editor' | 'fact_checker' | 'illustrator',
  dependencyKeys: readonly string[] = [],
  criticality: 'required' | 'optional' = 'required',
) {
  return {
    clientKey,
    owner,
    objective: `${owner} objective`,
    criticality,
    acceptanceCriteria: [`${owner} result is complete`],
    dependencyKeys,
    capabilities: [],
  };
}

function toolResponse(name: string, arguments_: Readonly<Record<string, unknown>>) {
  return fauxAssistantMessage([fauxToolCall(name, arguments_)], { stopReason: 'toolUse' });
}

function taskCompleteResponse(summary: string, status: 'succeeded' | 'failed' = 'succeeded') {
  return toolResponse('task_complete', {
    status,
    summary,
    artifacts: [],
    warnings: [],
    ...(status === 'failed' ? { failure: summary } : {}),
  });
}

function runCompleteResponse(answer: string) {
  return toolResponse('run_complete', { answer, artifactIds: [], evidenceIds: [] });
}

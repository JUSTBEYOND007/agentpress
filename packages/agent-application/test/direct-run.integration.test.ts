import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PiRuntimeAdapter, type AgentRuntime } from '@agentpress/agent-runtime';
import { ProposalService, registerArticleTools } from '@agentpress/editor-application';
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import {
  actionProposals,
  agentSessions,
  agentSessionCompactions,
  agentTranscriptEntries,
  agentTasks,
  agentRuns,
  appendConversationCompaction,
  appendRunEvent,
  approvals,
  appUsers,
  artifactEvidence,
  artifacts,
  artifactVersions,
  articleRevisions,
  articles,
  claimAgentTask,
  checkpoints,
  connectDatabase,
  contextPacks,
  conversationBranches,
  conversationCompactions,
  conversationMessages,
  conversations,
  executionPlans,
  editProposals,
  evidenceRecords,
  planRevisions,
  promptRevisions,
  rootRequests,
  runContextPacks,
  runDirectives,
  runEvents,
  runToolChoices,
  runSkillBindings,
  skillRevisionResources,
  skillRevisions,
  memoryCandidates,
  modelSelections,
  mentionBindings,
  queuedFollowups,
  requeueExpiredAgentTasks,
  taskResults,
  ToolChoiceQueueStore,
  toolCalls,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { hashToolArguments, ToolRegistry } from '@agentpress/tool-runtime';
import { Type } from '@sinclair/typebox';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ActionProposalService,
  AgentSessionCompactionService,
  AgentTranscriptProjector,
  ContextGovernanceService,
  DirectRunService,
  PersistentToolBridge,
  RunContextService,
  SkillSelectionError,
  runtimeToolName,
  ToolCallService,
  type LiveRunEvent,
  type RunEventPublisher,
} from '../src/index.js';
import { projectRunParts } from '../src/run-projection.js';

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

  it('rejects manual compaction when the branch does not belong to the requested conversation', async () => {
    await expect(
      service.compactConversation(randomUUID(), ids.branch, ids.user),
    ).rejects.toMatchObject({ code: 'unauthorized_user' });
  });

  it('persists a Pi-generated mid-turn summary against transcript sequence boundaries', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    const messageId = randomUUID();
    const requestId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    const sourceTranscriptEntryId = randomUUID();
    const summary = `The current request and completed tool result remain available. Protected references: ${runId}, ${sessionId}, ${sourceTranscriptEntryId}.`;
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      title: 'Session compaction',
    });
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    await connection.db.insert(conversationMessages).values({
      id: messageId,
      branchId,
      role: 'user',
      sequence: 1,
      content: [{ type: 'text', text: 'Run a tool-heavy turn' }],
      stable: true,
    });
    await connection.db.insert(rootRequests).values({
      id: requestId,
      branchId,
      messageId,
      requestedByUserId: ids.user,
      idempotencyKey: `session-compaction:${requestId}`,
    });
    await connection.db.insert(agentRuns).values({
      id: runId,
      workspaceId: ids.workspace,
      branchId,
      rootRequestId: requestId,
      mode: 'direct',
      status: 'completed',
    });
    await connection.db.insert(agentSessions).values({
      id: sessionId,
      runId,
      kind: 'main',
      attempt: 1,
      logicalKey: `${runId}:main:1`,
      model: 'faux/test',
      status: 'completed',
    });
    await connection.db.insert(agentTranscriptEntries).values([
      {
        id: sourceTranscriptEntryId,
        sessionId,
        sequence: 1,
        role: 'application',
        messageType: 'current_turn',
        content: { request: 'Run a tool-heavy turn' },
      },
      {
        id: randomUUID(),
        sessionId,
        sequence: 2,
        role: 'assistant',
        messageType: 'message',
        content: { toolCallId: 'mid-call' },
      },
      {
        id: randomUUID(),
        sessionId,
        sequence: 3,
        role: 'tool',
        messageType: 'tool_result',
        content: { toolCallId: 'mid-call', result: 'large result' },
      },
    ]);
    const compactions = new AgentSessionCompactionService({
      database: connection.db,
      runtimeFactory: {
        create: () =>
          PiRuntimeAdapter.forTests({
            responses: [
              fauxAssistantMessage(
                [
                  fauxToolCall('conversation_compaction_complete', {
                    summary,
                  }),
                ],
                { stopReason: 'toolUse' },
              ),
            ],
          }),
      },
      createId: randomUUID,
      now: () => new Date(),
      keepRecentTokens: 100,
    });

    await expect(
      compactions.compact({
        runId: sessionId,
        reason: 'mid_turn',
        contextWindow: 1_000,
        reserveTokens: 100,
        messages: [
          { index: 0, role: 'application', content: 'current request', tokenCount: 100 },
          {
            index: 1,
            role: 'assistant',
            content: 'tool call',
            tokenCount: 80,
            toolCallIds: ['mid-call'],
          },
          {
            index: 2,
            role: 'tool',
            content: 'large result',
            tokenCount: 60,
            toolCallId: 'mid-call',
          },
        ],
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      firstKeptMessageIndex: 1,
      summary,
    });
    const rows = await connection.db
      .select()
      .from(agentSessionCompactions)
      .where(eq(agentSessionCompactions.sessionId, sessionId));
    expect(rows[0]).toMatchObject({
      sourceFromSequence: 1,
      sourceThroughSequence: 1,
      firstKeptSequence: 2,
      status: 'completed',
      preserveData: {
        runId,
        runIds: [runId],
        sessionId,
      },
    });
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

  it('keeps PostgreSQL replay RunParts identical to the persisted event projection', async () => {
    const run = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: '回放 typed outcome',
      idempotencyKey: randomUUID(),
    });
    await connection.db.transaction(async (transaction) => {
      await appendRunEvent(transaction, {
        id: randomUUID(),
        runId: run.runId,
        eventType: 'task.timed_out',
        payload: { taskId: randomUUID(), reason: 'worker_deadline' },
      });
      await transaction
        .update(agentRuns)
        .set({ status: 'completed_with_degradation' })
        .where(eq(agentRuns.id, run.runId));
    });

    const events = await service.listEvents(run.runId);
    const replayParts = projectRunParts(events).filter(({ type }) => type !== 'usage');
    const projection = await service.getProjection(run.runId);
    expect(projection).toBeDefined();
    const projectedById = new Map(projection?.parts.map((part) => [part.id, part]));
    expect(replayParts.map((part) => projectedById.get(part.id))).toEqual(replayParts);
    expect(replayParts.find(({ status }) => status === 'task.timed_out')).toMatchObject({
      type: 'activity',
      outcome: 'timed_out',
    });
  });

  it('preserves a provider failure instead of relabeling it as a protocol failure', async () => {
    const providerFailureService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: () =>
          PiRuntimeAdapter.forTests({
            responses: [
              fauxAssistantMessage([], {
                stopReason: 'error',
                errorMessage: '503: model_not_found',
              }),
            ],
          }),
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await providerFailureService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: '你好',
      idempotencyKey: randomUUID(),
    });

    await expect(providerFailureService.execute(run.runId)).resolves.toMatchObject({
      status: 'failed',
    });
    const [storedRun] = await connection.db
      .select({ finalOutcome: agentRuns.finalOutcome })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    expect(storedRun?.finalOutcome).toMatchObject({
      error: { code: 'provider_error', message: '503: model_not_found' },
    });
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
      .where(eq(runEvents.runId, run.runId))
      .orderBy(asc(runEvents.sequence));
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
        toolResponse(runtimeToolName('article.propose_edits', '1.1.0'), {
          operations: [
            {
              kind: 'replace',
              blockId: 'mention-block',
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
      dispatchCommands: false,
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
    const receiptPart = projection?.parts.find(({ type }) => type === 'text');
    expect(receiptPart?.payload.message).toMatchObject({
      presentation: {
        kind: 'outcome_receipt',
        targetType: 'article-change',
        targetId: proposals[0]?.id,
      },
    });
    const stableMessages = await connection.db
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(eq(conversationMessages.runId, run.runId));
    expect(stableMessages[0]?.content).toMatchObject([
      {
        type: 'agentpress.runtime-message',
        message: {
          presentation: {
            kind: 'outcome_receipt',
            targetType: 'article-change',
            targetId: proposals[0]?.id,
          },
        },
      },
    ]);
  });

  it('exposes only host-granted article tools to a confirmed article edit turn', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    const articleId = randomUUID();
    const revisionId = randomUUID();
    const document = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'mention-block' },
          content: [{ type: 'text', text: 'Confirmed edit source' }],
        },
      ],
    };
    const documentHash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
    await connection.db.insert(articles).values({
      id: articleId,
      workspaceId: ids.workspace,
      title: 'Confirmed edit target',
    });
    await connection.db.insert(articleRevisions).values({
      id: revisionId,
      articleId,
      revisionNumber: 1,
      schemaVersion: 1,
      document,
      documentHash,
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId: revisionId })
      .where(eq(articles.id, articleId));
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      articleId,
      title: 'Confirmed direct article editing',
    });
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    const registry = new ToolRegistry();
    registerArticleTools(registry, connection.db, new ProposalService(connection.db));
    const toolCallsService = new ToolCallService({ database: connection.db, publisher, registry });
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: toolCallsService,
    });
    const delegate = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse(runtimeToolName('article.propose_edits', '1.1.0'), {
          operations: [
            {
              kind: 'replace',
              blockId: 'mention-block',
              block: {
                type: 'paragraph',
                attrs: { blockId: 'mention-block' },
                content: [{ type: 'text', text: 'Confirmed edit content' }],
              },
            },
          ],
        }),
        taskCompleteResponse('已生成确认动作对应的正文修改提案。'),
      ],
    });
    let exposedToolNames: readonly string[] = [];
    const confirmedRuntime: AgentRuntime = {
      execute(request, onEvent, signal) {
        exposedToolNames = (request.tools ?? []).map(({ name }) => name);
        return delegate.execute(request, onEvent, signal);
      },
    };
    const confirmedService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => confirmedRuntime },
      runtimeToolFactory: bridge,
      systemPrompt: 'You are AgentPress.',
      dispatchCommands: false,
    });
    const run = await confirmedService.createConfirmedAction({
      conversationId,
      branchId,
      userId: ids.user,
      proposalId: randomUUID(),
      instruction: '把正文改得更直接',
      articleId,
      baseRevisionId: revisionId,
      selectedBlocks: [],
      grantedCapabilities: ['article.read', 'article.propose'],
    });

    await expect(confirmedService.execute(run.runId)).resolves.toEqual({
      runId: run.runId,
      status: 'completed',
    });
    expect(exposedToolNames).toEqual([
      runtimeToolName('article.read_current', '1.0.0'),
      runtimeToolName('article.propose_edits', '1.1.0'),
      'task_complete',
    ]);
    await expect(
      connection.db.select().from(editProposals).where(eq(editProposals.runId, run.runId)),
    ).resolves.toMatchObject([{ status: 'pending' }]);
    await expect(
      connection.db.select().from(executionPlans).where(eq(executionPlans.runId, run.runId)),
    ).resolves.toHaveLength(1);
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

  it('projects an EditProposal artifact association without exposing its content', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const run = await service.create({
      conversationId: ids.conversation,
      branchId,
      userId: ids.user,
      prompt: '修改正文',
      idempotencyKey: randomUUID(),
    });
    const artifactId = randomUUID();
    const proposalId = randomUUID();
    await connection.db.insert(artifacts).values({
      id: artifactId,
      runId: run.runId,
      type: 'EditProposal',
      title: '正文修改',
      currentVersion: 1,
    });
    await connection.db.insert(artifactVersions).values({
      id: randomUUID(),
      artifactId,
      version: 1,
      summary: '已创建待审阅修改',
      content: { proposalId, expectedHash: 'internal-hash' },
      contentHash: createHash('sha256').update(proposalId).digest('hex'),
    });

    const projection = await service.getProjection(run.runId);
    expect(projection?.artifacts).toEqual([
      {
        id: artifactId,
        type: 'EditProposal',
        title: '正文修改',
        version: 1,
        summary: '已创建待审阅修改',
        presentation: {
          kind: 'outcome_artifact',
          targetType: 'article-change',
          targetId: proposalId,
        },
      },
    ]);
    expect(projection?.parts.find(({ type }) => type === 'artifact')?.payload).not.toHaveProperty(
      'content',
    );
    expect(JSON.stringify(projection)).not.toContain('internal-hash');
  });

  it('confirms a persisted action proposal concurrently into one authorized run', async () => {
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
    const confirmations = await Promise.all([
      actions.confirm(proposal.id, ids.user, service),
      actions.confirm(proposal.id, ids.user, service),
      actions.confirm(proposal.id, ids.user, service),
    ]);
    const confirmed = confirmations[0];
    const replay = await actions.confirm(proposal.id, ids.user, service);
    expect(confirmed).toMatchObject({ status: 'confirmed' });
    expect(new Set(confirmations.map(({ confirmedRunId }) => confirmedRunId))).toEqual(
      new Set([confirmed.confirmedRunId]),
    );
    expect(replay.confirmedRunId).toBe(confirmed.confirmedRunId);
    const [confirmedRuns, confirmedEvents] = await Promise.all([
      connection.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.branchId, branchId)),
      connection.db
        .select({ eventType: runEvents.eventType })
        .from(runEvents)
        .where(and(eq(runEvents.runId, source.runId), eq(runEvents.eventType, 'action.confirmed'))),
    ]);
    expect(confirmedRuns).toHaveLength(2);
    expect(confirmedEvents).toHaveLength(1);
  });

  it('persists action proposal expiration and rejects repeated confirmation without creating a run', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      articleId: ids.article,
      title: 'Expired action proposal',
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

    let clock = new Date('2026-08-07T00:00:00.000Z');
    const actions = new ActionProposalService(connection.db, publisher, () => clock);
    const proposal = await actions.create({
      runId: source.runId,
      instruction: '继续上一段',
      summary: '继续写作',
      selectedBlocks: [],
    });
    clock = new Date(clock.getTime() + 31 * 60 * 1000);

    await expect(actions.confirm(proposal.id, ids.user, service)).rejects.toThrow(
      'Action proposal has expired',
    );
    await expect(actions.confirm(proposal.id, ids.user, service)).rejects.toThrow(
      'Action proposal is expired',
    );

    const [stored, branchRuns, expirationEvents] = await Promise.all([
      connection.db
        .select()
        .from(actionProposals)
        .where(eq(actionProposals.id, proposal.id))
        .limit(1),
      connection.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.branchId, branchId)),
      connection.db
        .select({ eventType: runEvents.eventType })
        .from(runEvents)
        .where(and(eq(runEvents.runId, source.runId), eq(runEvents.eventType, 'action.expired'))),
    ]);
    expect(stored[0]).toMatchObject({ status: 'expired', confirmedRunId: null });
    expect(branchRuns).toHaveLength(1);
    expect(expirationEvents).toHaveLength(1);
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
    expect(packs[0]?.content).toContain('kind="mention" trust="untrusted"');
    expect(packs[0]?.content).toContain('kind="policy" trust="untrusted"');
    expect(packs[0]?.content).toContain('kind="memory" trust="untrusted"');
    await expect(service.getProjection(run.runId)).resolves.toMatchObject({
      context: {
        skillSelections: {
          explicit: [{ skillId: 'concise', version: '1.0.0' }],
          model: [],
          selected: [{ skillId: 'concise', version: '1.0.0' }],
        },
      },
    });
    const promptRows = await connection.db
      .select()
      .from(promptRevisions)
      .where(eq(promptRevisions.id, packs[0]?.promptRevisionId ?? randomUUID()));
    const promptRow = promptRows[0];
    expect(promptRow?.content).toBe('You are AgentPress.');
    expect(promptRow?.version).toMatch(/^1\.0\.0-/u);
    expect(promptRow?.snapshot).toEqual({
      schemaVersion: 1,
      templateVersion: promptRow?.version,
      variableSchemaVersion: 'none',
      renderedContentHash: promptRow?.contentHash,
      blocks: [
        {
          id: 'agentpress.main.rendered',
          contentHash: promptRow?.contentHash,
        },
      ],
    });
    expect(promptRow?.snapshotHash).toBe(promptRow?.contentHash);
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

  it('retrieves only relevant, current and accepted user memory into the persisted Context Pack', async () => {
    const relevantId = randomUUID();
    const expiredId = randomUUID();
    const pendingId = randomUUID();
    await connection.db.insert(memoryCandidates).values([
      {
        id: relevantId,
        workspaceId: ids.workspace,
        userId: ids.user,
        subject: 'publication cadence',
        value: 'Publish every Friday',
        valueHash: createHash('sha256').update('Publish every Friday').digest('hex'),
        confidenceBps: 8500,
        importanceBps: 9000,
        status: 'accepted',
      },
      {
        id: expiredId,
        workspaceId: ids.workspace,
        userId: ids.user,
        subject: 'publication cadence expired',
        value: 'Publish every Monday',
        valueHash: createHash('sha256').update('Publish every Monday').digest('hex'),
        confidenceBps: 10_000,
        importanceBps: 10_000,
        validUntil: new Date('2020-01-01T00:00:00.000Z'),
        status: 'accepted',
      },
      {
        id: pendingId,
        workspaceId: ids.workspace,
        userId: ids.user,
        subject: 'publication cadence pending',
        value: 'Publish every day',
        valueHash: createHash('sha256').update('Publish every day').digest('hex'),
        confidenceBps: 10_000,
        importanceBps: 10_000,
        status: 'pending',
      },
    ]);
    const run = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: 'publication cadence',
      idempotencyKey: randomUUID(),
    });
    const packs = await connection.db
      .select({ content: runContextPacks.content, manifest: runContextPacks.manifest })
      .from(runContextPacks)
      .where(eq(runContextPacks.runId, run.runId));
    expect(packs[0]?.content).toContain(`id="${relevantId}" kind="memory" trust="untrusted"`);
    expect(packs[0]?.content).not.toContain(expiredId);
    expect(packs[0]?.content).not.toContain(pendingId);
    expect(packs[0]?.manifest).toMatchObject({
      retrievalVersion: 'accepted-memory.hybrid-v1',
    });
    await service.requestCancellation(run.runId);
    await service.execute(run.runId);
  });

  it('creates consolidation as a pending candidate and supersedes sources only after acceptance', async () => {
    const sourceIds: string[] = [randomUUID(), randomUUID()];
    await connection.db.insert(memoryCandidates).values(
      sourceIds.map((id, index) => ({
        id,
        workspaceId: ids.workspace,
        userId: ids.user,
        subject: 'editor preference',
        value: index === 0 ? 'Use short paragraphs' : 'Include supporting evidence',
        valueHash: createHash('sha256')
          .update(`consolidation-source-${String(index)}`)
          .digest('hex'),
        confidenceBps: 8000 + index * 500,
        importanceBps: 7000 + index * 1000,
        sourceEvidenceIds: [`evidence-${String(index)}`],
        status: 'accepted' as const,
      })),
    );
    const consolidated = await governance.proposeMemoryConsolidation(ids.workspace, ids.user, {
      sourceCandidateIds: sourceIds,
      subject: 'editor preference',
      value: 'Use short evidence-backed paragraphs',
      confidence: 0.95,
    });
    expect(consolidated).toMatchObject({
      status: 'pending',
      sourceMemoryIds: sourceIds,
      sourceEvidenceIds: ['evidence-0', 'evidence-1'],
      importanceBps: 8000,
    });
    const before = await connection.db
      .select({ status: memoryCandidates.status })
      .from(memoryCandidates)
      .where(inArray(memoryCandidates.id, sourceIds));
    expect(before.map(({ status }) => status)).toEqual(['accepted', 'accepted']);

    await governance.decideMemory(ids.workspace, ids.user, consolidated.id, 'accepted');
    const after = await connection.db
      .select({ id: memoryCandidates.id, status: memoryCandidates.status })
      .from(memoryCandidates)
      .where(inArray(memoryCandidates.id, [...sourceIds, consolidated.id]));
    expect(after.find(({ id }) => id === consolidated.id)?.status).toBe('accepted');
    expect(after.filter(({ id }) => sourceIds.includes(id)).map(({ status }) => status)).toEqual([
      'superseded',
      'superseded',
    ]);
  });

  it('pins model-selected Skill revisions and rejects model attempts to select hidden Skills', async () => {
    const selectingService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
      skillPreselector: {
        select(input) {
          expect(input.candidates).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ skillId: 'concise', version: '1.0.0' }),
            ]),
          );
          return Promise.resolve([{ skillId: 'concise', version: '1.0.0' }]);
        },
      },
    });
    const run = await selectingService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: 'Select a useful Skill.',
      idempotencyKey: randomUUID(),
    });
    const [bindings, events] = await Promise.all([
      connection.db.select().from(runSkillBindings).where(eq(runSkillBindings.runId, run.runId)),
      connection.db.select().from(runEvents).where(eq(runEvents.runId, run.runId)),
    ]);
    expect(bindings).toMatchObject([{ skillRevisionId: ids.skillRevision }]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'skill.selection.completed',
          payload: expect.objectContaining({
            model: [{ skillId: 'concise', version: '1.0.0' }],
          }) as unknown,
        }),
      ]),
    );
    await selectingService.requestCancellation(run.runId);
    await selectingService.execute(run.runId);

    await governance.createSkill(
      ids.workspace,
      '---\nid: hidden-only\nversion: 1.0.0\ndescription: Hidden\nhidden: true\n---\nNever model-select this Skill.',
    );
    const badIdempotencyKey = randomUUID();
    const maliciousService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
      skillPreselector: {
        select: () => Promise.resolve([{ skillId: 'hidden-only', version: '1.0.0' }]),
      },
    });
    await expect(
      maliciousService.create({
        conversationId: ids.conversation,
        userId: ids.user,
        branchId: ids.branch,
        prompt: 'Try to select a hidden Skill.',
        idempotencyKey: badIdempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'invalid_context' });
    await expect(
      connection.db
        .select({ id: rootRequests.id })
        .from(rootRequests)
        .where(eq(rootRequests.idempotencyKey, badIdempotencyKey)),
    ).resolves.toHaveLength(0);
  });

  it('keeps disabled and malformed Skills visible as catalog diagnostics', async () => {
    const disabledId = `explicit-only-${randomUUID()}`;
    await governance.createSkill(
      ids.workspace,
      `---\nid: ${disabledId}\nversion: 1.0.0\ndescription: Explicit only\ndisable-model-invocation: true\n---\nUse only when the user asks.`,
    );
    const malformedId = `broken-${randomUUID()}`;
    await connection.db.insert(skillRevisions).values({
      id: randomUUID(),
      workspaceId: ids.workspace,
      skillId: malformedId,
      version: '1.0.0',
      content: 'not a Skill document',
      contentHash: 'malformed-fixture',
      allowedTools: [],
    });

    const listed = await governance.listSkills(ids.workspace);
    expect(listed.find(({ skillId }) => skillId === disabledId)).toMatchObject({
      status: 'policy_disabled',
    });
    expect(listed.find(({ skillId }) => skillId === malformedId)).toMatchObject({
      status: 'load_failed',
      description: '技能加载失败，无法绑定。',
    });
  });

  it('keeps malformed catalog entries out of model selection without blocking Run creation', async () => {
    const malformedId = `preselection-broken-${randomUUID()}`;
    await connection.db.insert(skillRevisions).values({
      id: randomUUID(),
      workspaceId: ids.workspace,
      skillId: malformedId,
      version: '1.0.0',
      content: 'not a Skill document',
      contentHash: 'malformed-preselection-fixture',
      allowedTools: [],
    });
    let modelPrompt = '';
    const selectionService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
      skillPreselector: {
        select: ({ candidates }) => {
          modelPrompt = JSON.stringify(candidates);
          return Promise.resolve([]);
        },
      },
    });
    const run = await selectionService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: '继续处理，但不要选择损坏 Skill。',
      idempotencyKey: randomUUID(),
    });
    expect(modelPrompt).not.toContain(malformedId);
    const events = await connection.db
      .select({ eventType: runEvents.eventType, payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.runId, run.runId));
    expect(
      events.find(({ eventType }) => eventType === 'skill.selection.completed')?.payload,
    ).toMatchObject({
      catalogFailures: [{ skillId: malformedId, version: '1.0.0', code: 'load_failed' }],
    });
    await selectionService.requestCancellation(run.runId);
    await selectionService.execute(run.runId);
  });

  it('preserves explicit Skills when model preselection times out', async () => {
    const selectingService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
      skillPreselector: {
        select: () => Promise.reject(new SkillSelectionError('timeout', 'selection timed out')),
      },
    });
    const run = await selectingService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: 'Use the explicit Skill even if model selection times out.',
      idempotencyKey: randomUUID(),
      skills: [{ skillId: 'concise', version: '1.0.0' }],
    });
    await expect(
      connection.db
        .select({ eventType: runEvents.eventType })
        .from(runEvents)
        .where(eq(runEvents.runId, run.runId)),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: 'skill.selection.completed' })]),
    );
    await expect(selectingService.getProjection(run.runId)).resolves.toMatchObject({
      context: {
        skillSelections: {
          model: [],
          selected: [{ skillId: 'concise', version: '1.0.0' }],
          modelSelection: { status: 'failed', code: 'timeout' },
        },
      },
    });
    await selectingService.requestCancellation(run.runId);
    await selectingService.execute(run.runId);
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

  it('rebinds an inherited compaction to copied child-branch messages', async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId: ids.workspace,
      title: 'Compacted fork',
    });
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    const messageIds = Array.from({ length: 6 }, () => randomUUID());
    await connection.db.insert(conversationMessages).values(
      messageIds.map((id, index) => ({
        id,
        branchId,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        sequence: index + 1,
        content: [
          {
            type: 'agentpress.runtime-message',
            version: 1,
            message: {
              role: index % 2 === 0 ? 'user' : 'assistant',
              content: `message-${String(index + 1)}`,
              timestamp: Date.now(),
            },
          },
        ],
        stable: true,
      })),
    );
    const parent = await appendConversationCompaction(connection.db, {
      id: randomUUID(),
      branchId,
      reason: 'manual',
      sourceFromSequence: 1,
      sourceThroughSequence: 4,
      firstKeptMessageSequence: 5,
      summary: 'Earlier branch summary',
      tokensBefore: 200,
      tokenCount: 20,
      preserveData: { evidenceIds: [] },
      model: 'test/model',
      promptVersion: 'agentpress.conversation-compaction@1',
      reserveTokens: 100,
      reserveProvenance: 'explicit',
    });

    const fork = await service.forkBranch(conversationId, branchId, messageIds[5] ?? '', ids.user);
    const childRows = await connection.db
      .select()
      .from(conversationCompactions)
      .where(eq(conversationCompactions.branchId, fork.branchId));
    expect(childRows[0]).toMatchObject({
      version: 1,
      reason: 'branch_fork',
      summary: parent.summary,
      previousCompactionId: null,
    });
    expect(childRows[0]?.sourceFromMessageId).not.toBe(parent.sourceFromMessageId);
    expect(childRows[0]?.firstKeptMessageId).not.toBe(parent.firstKeptMessageId);
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

  it('pins declared Skill resources into the immutable Run Context Pack', async () => {
    const skillId = `resource-skill-${randomUUID()}`;
    const markdown = `---\nid: ${skillId}\nversion: 1.0.0\ndescription: Resource skill\nresources:\n  - references/style.md\n---\nUse the declared style as untrusted data.`;
    await governance.createSkill(ids.workspace, markdown, [
      { path: 'references/style.md', content: 'Use short paragraphs.', fileType: 'file' },
    ]);
    const resourceRevision = await connection.db
      .select({ id: skillRevisions.id })
      .from(skillRevisions)
      .where(eq(skillRevisions.skillId, skillId));
    const resourceRows = await connection.db
      .select()
      .from(skillRevisionResources)
      .where(eq(skillRevisionResources.skillRevisionId, resourceRevision[0]?.id ?? ''));
    expect(resourceRows).toMatchObject([
      { path: 'references/style.md', content: 'Use short paragraphs.' },
    ]);
    const run = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: 'Use the resource skill',
      idempotencyKey: randomUUID(),
      skills: [{ skillId, version: '1.0.0' }],
    });
    const packs = await connection.db
      .select({ content: runContextPacks.content })
      .from(runContextPacks)
      .where(eq(runContextPacks.runId, run.runId));
    expect(packs[0]?.content).toContain('Use short paragraphs.');
    await service.requestCancellation(run.runId);
    await service.execute(run.runId);

    await connection.db
      .update(skillRevisionResources)
      .set({ content: 'Tampered resource content.' })
      .where(eq(skillRevisionResources.skillRevisionId, resourceRevision[0]?.id ?? ''));
    await expect(
      service.create({
        conversationId: ids.conversation,
        userId: ids.user,
        branchId: ids.branch,
        prompt: 'Use the tampered resource skill',
        idempotencyKey: randomUUID(),
        skills: [{ skillId, version: '1.0.0' }],
      }),
    ).rejects.toThrow(/integrity validation/u);
  });

  it('replays a Run with its pinned Skill revision after a newer revision is published', async () => {
    const skillId = `replay-skill-${randomUUID()}`;
    await governance.createSkill(
      ids.workspace,
      `---\nid: ${skillId}\nversion: 1.0.0\ndescription: Pinned replay skill\nallowedTools:\n  - article.read_current\n---\nUse revision one.`,
    );
    const run = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: 'Replay this pinned Skill',
      idempotencyKey: randomUUID(),
      skills: [{ skillId, version: '1.0.0' }],
    });
    const before = await connection.db
      .select({ content: runContextPacks.content, contentHash: runContextPacks.contentHash })
      .from(runContextPacks)
      .where(eq(runContextPacks.runId, run.runId));
    const bindingsBefore = await connection.db
      .select()
      .from(runSkillBindings)
      .where(eq(runSkillBindings.runId, run.runId));

    await governance.createSkill(
      ids.workspace,
      `---\nid: ${skillId}\nversion: 2.0.0\ndescription: New replay skill\nallowedTools:\n  - web_research.search\n---\nUse revision two.`,
    );

    const restartedContexts = new RunContextService(connection.db, 'You are AgentPress.');
    await expect(restartedContexts.load(run.runId)).resolves.toMatchObject({
      content: before[0]?.content,
      contentHash: before[0]?.contentHash,
    });
    const bindingsAfter = await connection.db
      .select()
      .from(runSkillBindings)
      .where(eq(runSkillBindings.runId, run.runId));
    expect(bindingsAfter).toEqual(bindingsBefore);
    expect(bindingsAfter[0]?.allowedTools).toEqual(['article.read_current']);

    await service.requestCancellation(run.runId);
    await service.execute(run.runId);

    const siblingBranchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: siblingBranchId,
      conversationId: ids.conversation,
    });
    const siblingRun = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: siblingBranchId,
      prompt: 'Use the newer Skill only on this branch',
      idempotencyKey: randomUUID(),
      skills: [{ skillId, version: '2.0.0' }],
    });
    const unboundRun = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId: ids.branch,
      prompt: 'Do not inherit a Skill from the previous turn',
      idempotencyKey: randomUUID(),
    });
    const [siblingPack, unboundPack, siblingBindings, unboundBindings] = await Promise.all([
      restartedContexts.load(siblingRun.runId),
      restartedContexts.load(unboundRun.runId),
      connection.db
        .select()
        .from(runSkillBindings)
        .where(eq(runSkillBindings.runId, siblingRun.runId)),
      connection.db
        .select()
        .from(runSkillBindings)
        .where(eq(runSkillBindings.runId, unboundRun.runId)),
    ]);
    expect(siblingPack?.content).toContain('Use revision two.');
    expect(siblingPack?.content).not.toContain('Use revision one.');
    expect(siblingBindings).toHaveLength(1);
    expect(siblingBindings[0]?.allowedTools).toEqual(['web_research.search']);
    expect(unboundPack?.content).not.toContain('Use revision one.');
    expect(unboundPack?.content).not.toContain('Use revision two.');
    expect(unboundBindings).toEqual([]);

    await service.requestCancellation(siblingRun.runId);
    await service.execute(siblingRun.runId);
    await service.requestCancellation(unboundRun.runId);
    await service.execute(unboundRun.runId);
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

  it('aborts a timed-out Specialist and persists task_timeout instead of hanging', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const main = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', {
          goal: 'Exercise the Specialist timeout boundary',
          tasks: [plannedTask('timeout-writer', 'writer', [], 'optional')],
        }),
        runCompleteResponse('Specialist timed out; the run completed with degradation.'),
      ],
    });
    const hangingSpecialist: AgentRuntime = {
      execute(_request, _sink, signal) {
        return new Promise((resolve) => {
          const settle = () => {
            resolve({ status: 'cancelled', messages: [] });
          };
          if (signal?.aborted) settle();
          else signal?.addEventListener('abort', settle, { once: true });
        });
      },
    };
    const timeoutService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: (purpose) => (purpose === 'writer' ? hangingSpecialist : main) },
      systemPrompt: 'You are AgentPress.',
      taskTimeoutMs: 25,
    });
    const run = await timeoutService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: 'Run the bounded timeout scenario',
      idempotencyKey: randomUUID(),
    });

    await expect(timeoutService.execute(run.runId)).resolves.toEqual({
      runId: run.runId,
      status: 'completed_with_degradation',
    });
    await expect(
      connection.db
        .select({ status: taskResults.status, failure: taskResults.failure })
        .from(taskResults)
        .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
        .where(eq(agentTasks.runId, run.runId)),
    ).resolves.toEqual([
      {
        status: 'failed',
        failure: { code: 'task_timeout', message: 'task_timeout' },
      },
    ]);
    const projection = await timeoutService.getProjection(run.runId);
    expect(projection?.parts.find(({ status }) => status === 'task.failed')).toMatchObject({
      outcome: 'timed_out',
      payload: { failure: 'task_timeout' },
    });
  });

  it('rejects an invalid Specialist timeout instead of falling back to the default', () => {
    expect(
      () =>
        new DirectRunService({
          database: connection.db,
          publisher,
          runtimeFactory: { create: () => runtime },
          systemPrompt: 'You are AgentPress.',
          taskTimeoutMs: 0,
        }),
    ).toThrow('Specialist Task timeout must be between 1 ms and 10 minutes');
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
    expect(
      persistedTasks.every(({ toolPolicy, budget }) => {
        const request = toolPolicy.request as Record<string, unknown>;
        return (
          request.taskId !== undefined &&
          request.runId === run.runId &&
          request.depth === 0 &&
          request.detached === false &&
          request.timeoutMs === 120_000 &&
          request.maxAttempts === 3 &&
          (budget as Record<string, unknown>).timeoutMs === 120_000
        );
      }),
    ).toBe(true);
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
          Array.isArray(manifest.capabilities) &&
          manifest.depth === 0 &&
          manifest.detached === false,
      ),
    ).toBe(true);
    expect(
      contexts.every(({ content }) => {
        const envelope = JSON.parse(content) as {
          readonly rootRequest?: {
            readonly request?: unknown;
            readonly context?: unknown;
            readonly actionEnvelope?: { readonly grantedCapabilities?: readonly string[] };
          };
        };
        return (
          envelope.rootRequest?.request === '' &&
          envelope.rootRequest.context === undefined &&
          envelope.rootRequest.actionEnvelope?.grantedCapabilities?.length === 0 &&
          !content.includes('联网搜索最新资料并写一篇图文文章')
        );
      }),
    ).toBe(true);
    const results = await connection.db.select().from(taskResults);
    expect(
      results.filter(({ taskId }) => persistedTasks.some(({ id }) => id === taskId)),
    ).toHaveLength(5);
    const events = await connection.db
      .select({ eventType: runEvents.eventType, payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.runId, run.runId));
    expect(events.filter(({ eventType }) => eventType === 'plan.revised')).toHaveLength(1);
    const settledTaskEvents = events.filter(({ eventType }) => eventType === 'task.succeeded');
    expect(settledTaskEvents).toHaveLength(5);
    expect(
      settledTaskEvents.every(({ payload }) =>
        Number.isSafeInteger((payload as Record<string, unknown>).attempt),
      ),
    ).toBe(true);
    const choices = await connection.db
      .select({
        choice: runToolChoices.choice,
        status: runToolChoices.status,
        claimToken: runToolChoices.claimToken,
      })
      .from(runToolChoices)
      .where(eq(runToolChoices.runId, run.runId));
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({
      choice: { type: 'tool', name: 'run_complete' },
      status: 'resolved',
    });
    expect(typeof choices[0]?.claimToken).toBe('string');
    const projection = await plannedService.getProjection(run.runId);
    expect(projection?.agents).toHaveLength(6);
    expect(new Set(projection?.agents.map(({ owner }) => owner))).toEqual(
      new Set(['main', 'researcher', 'writer', 'editor', 'fact_checker', 'illustrator']),
    );
    expect(projection?.agents.slice(1).every(({ status }) => status === 'succeeded')).toBe(true);
    expect(events.some(({ eventType }) => eventType === 'synthesis.failed')).toBe(false);
  });

  it('persists a typed synthesis failure without exposing provider details in its public fact', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', {
          goal: 'Produce an article',
          tasks: [plannedTask('write', 'writer')],
        }),
        taskCompleteResponse('Draft completed'),
        'ordinary response one',
        'ordinary response two',
        'ordinary response three',
      ],
    });
    const synthesisService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await synthesisService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '写一篇文章并给出最终结果',
      idempotencyKey: randomUUID(),
    });

    await expect(synthesisService.execute(run.runId)).resolves.toEqual({
      runId: run.runId,
      status: 'failed',
    });
    const events = await connection.db
      .select({ eventType: runEvents.eventType, payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.runId, run.runId))
      .orderBy(asc(runEvents.sequence));
    const synthesisFailure = events.find(({ eventType }) => eventType === 'synthesis.failed');
    expect(synthesisFailure?.payload).toEqual({
      code: 'synthesis_failed',
      causeCode: 'protocol_error',
      messageKey: 'synthesis.failed',
      retryable: true,
    });
    expect(JSON.stringify(synthesisFailure?.payload)).not.toContain('Main Agent did not call');
    expect(events.at(-1)).toMatchObject({
      eventType: 'run.failed',
      payload: { failureStage: 'synthesis' },
    });
    const projection = await synthesisService.getProjection(run.runId);
    expect(
      projection?.parts.filter(({ type, status }) => type === 'warning' && status === 'run.failed'),
    ).toHaveLength(1);
    expect(projection?.parts.some(({ status }) => status === 'synthesis.failed')).toBe(false);
  });

  it('projects only a Specialist public result to Main while keeping private thinking isolated', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const task = plannedTask('private-reasoning-boundary', 'researcher');
    const privateThinking = 'PRIVATE-SPECIALIST-THINKING-84921';
    const publicSummary = 'Public source-backed research summary';
    const delegate = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', {
          goal: 'Verify the Specialist result boundary',
          tasks: [task],
        }),
        fauxAssistantMessage(
          [
            fauxThinking(privateThinking),
            fauxToolCall('task_complete', {
              status: 'succeeded',
              summary: publicSummary,
              artifacts: [],
              warnings: [],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        runCompleteResponse('Main used only the public Specialist result.'),
      ],
    });
    const observedMainSynthesisTurns: unknown[] = [];
    const runtime: AgentRuntime = {
      execute(request, sink, signal) {
        if (request.tools?.some(({ name }) => name === 'run_complete')) {
          observedMainSynthesisTurns.push(request.currentTurn);
        }
        return delegate.execute(request, sink, signal);
      },
    };
    const isolatedService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await isolatedService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '完成研究并只向 Main 返回公开结论',
      idempotencyKey: randomUUID(),
    });

    await expect(isolatedService.execute(run.runId)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(observedMainSynthesisTurns).toHaveLength(1);
    expect(JSON.stringify(observedMainSynthesisTurns)).toContain(publicSummary);
    expect(JSON.stringify(observedMainSynthesisTurns)).not.toContain(privateThinking);

    const persistedResults = await connection.db
      .select({ summary: taskResults.summary, artifacts: taskResults.artifacts })
      .from(taskResults)
      .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
      .where(eq(agentTasks.runId, run.runId));
    expect(persistedResults).toEqual([{ summary: publicSummary, artifacts: [] }]);
    expect(JSON.stringify(persistedResults)).not.toContain(privateThinking);

    const transcriptRows = await connection.db
      .select({ kind: agentSessions.kind, content: agentTranscriptEntries.content })
      .from(agentTranscriptEntries)
      .innerJoin(agentSessions, eq(agentSessions.id, agentTranscriptEntries.sessionId))
      .where(eq(agentSessions.runId, run.runId));
    const specialistTranscript = transcriptRows.filter(({ kind }) => kind === 'specialist');
    const mainTranscript = transcriptRows.filter(({ kind }) => kind === 'main');
    expect(JSON.stringify(specialistTranscript)).toContain(privateThinking);
    expect(JSON.stringify(mainTranscript)).not.toContain(privateThinking);
  });

  it('derives persisted ResearchBrief Evidence edges from the canonical source directory', async () => {
    const branchId = randomUUID();
    const evidenceId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const task = plannedTask('research-brief-evidence-closure', 'researcher');
    const sourceToolCallId = randomUUID();
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', { goal: 'Persist a ResearchBrief', tasks: [task] }),
        toolResponse('task_complete', {
          status: 'succeeded',
          summary: 'Source-backed research',
          artifacts: [
            {
              type: 'ResearchBrief',
              title: 'Research brief',
              summary: 'One verified finding',
              content: {
                schemaVersion: 1,
                purpose: 'fact-check',
                depth: 'quick',
                claims: [{ text: 'Verified claim', evidenceIds: [evidenceId], confidence: 0.9 }],
                conflicts: [],
                unknowns: [],
                implications: [],
                sources: [
                  {
                    evidenceId,
                    title: 'Primary source',
                    sourceUri: 'https://example.com/source',
                  },
                ],
                queryLog: [{ query: 'verified query', resultCount: 1 }],
                partialFailures: [],
              },
            },
          ],
          warnings: [],
        }),
        runCompleteResponse('Research completed.'),
      ],
    });
    const insertedTasks = new Set<string>();
    const researchService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      runtimeToolFactory: {
        listCapabilities: () => Promise.resolve(['web.research']),
        async createForRun(runId, _capabilities, taskId) {
          if (taskId && !insertedTasks.has(taskId)) {
            insertedTasks.add(taskId);
            await connection.db.insert(toolCalls).values({
              id: sourceToolCallId,
              runId,
              taskId,
              toolId: 'web.search',
              toolVersion: '1.0.0',
              evidenceProviderRevision: 'anysearch-api-v1+pi-web-access-v0.15.0',
              arguments: { query: 'verified query' },
              argumentsHash: hashToolArguments({ query: 'verified query' }),
              risk: 'read_only',
              sideEffect: 'No side effect',
              status: 'succeeded',
            });
            await connection.db.insert(evidenceRecords).values({
              id: evidenceId,
              runId,
              taskId,
              sourceToolCallId,
              sourceType: 'tool',
              sourceUri: 'https://example.com/source',
              title: 'Primary source',
              excerpt: 'Verified evidence excerpt',
              sourceRevision: 'source-v1',
              contentHash: createHash('sha256').update('Verified evidence excerpt').digest('hex'),
              metadata: { toolId: 'web.search', toolVersion: '1.0.0' },
            });
          }
          return [];
        },
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await researchService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '只研究并返回 ResearchBrief',
      idempotencyKey: randomUUID(),
    });

    await expect(researchService.execute(run.runId)).resolves.toMatchObject({
      status: 'completed',
    });
    const persisted = await connection.db
      .select({ content: artifactVersions.content, evidenceId: artifactEvidence.evidenceId })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .innerJoin(artifactEvidence, eq(artifactEvidence.artifactVersionId, artifactVersions.id))
      .where(eq(artifacts.runId, run.runId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.evidenceId).toBe(evidenceId);
    expect(persisted[0]?.content).toEqual(
      expect.objectContaining({
        summary: 'One verified finding',
        confidence: 0.9,
        sources: [expect.objectContaining({ evidenceId })],
        providerRevision: 'anysearch-api-v1+pi-web-access-v0.15.0',
      }),
    );
  });

  it('repairs a failed Specialist protocol twice before accepting task_complete', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const task = plannedTask('repairable', 'writer');
    const delegate = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', { goal: 'Repair specialist completion', tasks: [task] }),
        'Stopped without calling task_complete.',
        taskCompleteResponse('Recovered after protocol repair'),
        runCompleteResponse('协议修复后完成。'),
      ],
    });
    const observedSpecialistTurns: unknown[] = [];
    const runtime: AgentRuntime = {
      execute(request, sink, signal) {
        if (request.tools?.some(({ name }) => name === 'task_complete')) {
          observedSpecialistTurns.push(request.currentTurn);
        }
        return delegate.execute(request, sink, signal);
      },
    };
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
    expect(observedSpecialistTurns).toHaveLength(2);
    expect(JSON.stringify(observedSpecialistTurns[0])).toContain(task.objective);
    expect(JSON.stringify(observedSpecialistTurns[1])).toContain(task.objective);
    expect(JSON.stringify(observedSpecialistTurns[1])).toContain('Protocol repair');
    expect(
      observedSpecialistTurns.every(
        (turn) =>
          typeof turn === 'object' &&
          turn !== null &&
          !('context' in turn) &&
          'actionEnvelope' in turn &&
          JSON.stringify(turn.actionEnvelope) ===
            JSON.stringify({ version: 1, source: 'free_text', grantedCapabilities: [] }),
      ),
    ).toBe(true);
  });

  it('persists invalid Specialist Evidence as a typed Task failure after bounded repair', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const task = plannedTask('invalid-evidence', 'writer');
    const invalidCompletion = toolResponse('task_complete', {
      status: 'succeeded',
      summary: 'Draft with invalid Evidence',
      artifacts: [
        {
          type: 'ArticleDraft',
          title: 'Draft',
          summary: 'Draft summary',
          content: {},
          evidenceIds: [randomUUID()],
        },
      ],
      warnings: [],
    });
    const invalidService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: () =>
          PiRuntimeAdapter.forTests({
            responses: [
              toolResponse('plan_submit', { goal: 'Reject invalid Evidence', tasks: [task] }),
              invalidCompletion,
              invalidCompletion,
              invalidCompletion,
            ],
          }),
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await invalidService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '生成草稿，但拒绝越界 Evidence。',
      idempotencyKey: randomUUID(),
    });

    await expect(invalidService.execute(run.runId)).resolves.toMatchObject({ status: 'failed' });
    await expect(
      connection.db
        .select({ failure: taskResults.failure })
        .from(taskResults)
        .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
        .where(eq(agentTasks.runId, run.runId)),
    ).resolves.toEqual([
      { failure: { code: 'task_evidence_invalid', message: 'task_evidence_invalid' } },
    ]);
    const events = await connection.db
      .select({ eventType: runEvents.eventType, payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.runId, run.runId));
    expect(events.find(({ eventType }) => eventType === 'task.failed')?.payload).toMatchObject({
      failure: 'task_evidence_invalid',
    });
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
    const [cancelledResults, cancelledArtifacts, cancellationEvents] = await Promise.all([
      connection.db
        .select({ id: taskResults.id })
        .from(taskResults)
        .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
        .where(eq(agentTasks.runId, run.runId)),
      connection.db
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.runId, run.runId)),
      connection.db
        .select({ eventType: runEvents.eventType })
        .from(runEvents)
        .where(eq(runEvents.runId, run.runId)),
    ]);
    expect(cancelledResults).toEqual([]);
    expect(cancelledArtifacts).toEqual([]);
    expect(
      cancellationEvents.filter(({ eventType }) => eventType === 'task.cancelled'),
    ).toHaveLength(1);
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
    const choiceId = randomUUID();
    const staleClaimToken = randomUUID();
    await connection.db.insert(runToolChoices).values({
      id: choiceId,
      runId: run.runId,
      sequence: 1,
      choice: { type: 'tool', name: 'run_complete' },
      label: 'recover completion',
      status: 'in_flight',
      claimToken: staleClaimToken,
      claimedAt: new Date(),
    });

    await expect(recoveryService.prepareRecovery(run.runId)).resolves.toBe(true);
    const [eventsAfterFirstRecovery, checkpointsAfterFirstRecovery] = await Promise.all([
      connection.db
        .select({ eventType: runEvents.eventType })
        .from(runEvents)
        .where(eq(runEvents.runId, run.runId)),
      connection.db
        .select({ id: checkpoints.id })
        .from(checkpoints)
        .where(eq(checkpoints.runId, run.runId)),
    ]);
    await expect(recoveryService.prepareRecovery(run.runId)).resolves.toBe(true);
    const [eventsAfterDuplicateRecovery, checkpointsAfterDuplicateRecovery] = await Promise.all([
      connection.db
        .select({ eventType: runEvents.eventType })
        .from(runEvents)
        .where(eq(runEvents.runId, run.runId)),
      connection.db
        .select({ id: checkpoints.id })
        .from(checkpoints)
        .where(eq(checkpoints.runId, run.runId)),
    ]);
    expect(eventsAfterDuplicateRecovery).toEqual(eventsAfterFirstRecovery);
    expect(checkpointsAfterDuplicateRecovery).toEqual(checkpointsAfterFirstRecovery);
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
    await expect(
      connection.db
        .select({
          status: runToolChoices.status,
          claimToken: runToolChoices.claimToken,
          recoveryCount: runToolChoices.recoveryCount,
        })
        .from(runToolChoices)
        .where(eq(runToolChoices.id, choiceId)),
    ).resolves.toEqual([{ status: 'pending', claimToken: null, recoveryCount: 1 }]);
    const choices = new ToolChoiceQueueStore(connection.db, randomUUID);
    await expect(
      choices.settle({ id: choiceId, claimToken: staleClaimToken, status: 'resolved' }),
    ).resolves.toBe(false);
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

  it('restores only committed one-to-one ToolCall facts from PostgreSQL transcripts', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const run = await service.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '恢复可信历史',
      idempotencyKey: randomUUID(),
    });
    const completedSessionId = randomUUID();
    const interruptedSessionId = randomUUID();
    await connection.db.insert(agentSessions).values([
      {
        id: completedSessionId,
        runId: run.runId,
        kind: 'main',
        attempt: 1,
        logicalKey: `${run.runId}:main:1`,
        model: 'old-model',
        status: 'completed',
      },
      {
        id: interruptedSessionId,
        runId: run.runId,
        kind: 'main',
        attempt: 2,
        logicalKey: `${run.runId}:main:2`,
        model: 'old-model',
        status: 'interrupted',
      },
    ]);
    const toolResult = (toolCallId: string, toolName: string, content: string) => ({
      result: {
        role: 'tool',
        toolCallId,
        toolName,
        content,
        isError: false,
        timestamp: 10,
      },
    });
    await connection.db.insert(agentTranscriptEntries).values([
      {
        id: randomUUID(),
        sessionId: completedSessionId,
        sequence: 3,
        role: 'tool',
        messageType: 'tool_result',
        providerToolCallId: 'valid-call',
        content: toolResult('valid-call', 'read', 'verified-result'),
      },
      {
        id: randomUUID(),
        sessionId: completedSessionId,
        sequence: 1,
        role: 'user',
        messageType: 'message',
        content: { message: { role: 'user', content: 'committed-request', timestamp: 1 } },
      },
      {
        id: randomUUID(),
        sessionId: completedSessionId,
        sequence: 2,
        role: 'assistant',
        messageType: 'tool_call',
        providerToolCallId: 'valid-call',
        content: { name: 'read', arguments: {} },
      },
      {
        id: randomUUID(),
        sessionId: completedSessionId,
        sequence: 4,
        role: 'tool',
        messageType: 'tool_result',
        providerToolCallId: 'orphan-call',
        content: toolResult('orphan-call', 'read', 'orphan-result'),
      },
      {
        id: randomUUID(),
        sessionId: completedSessionId,
        sequence: 5,
        role: 'assistant',
        messageType: 'tool_call',
        providerToolCallId: 'duplicate-call',
        content: { name: 'read', arguments: {} },
      },
      {
        id: randomUUID(),
        sessionId: completedSessionId,
        sequence: 6,
        role: 'tool',
        messageType: 'tool_result',
        providerToolCallId: 'duplicate-call',
        content: toolResult('duplicate-call', 'read', 'duplicate-result-1'),
      },
      {
        id: randomUUID(),
        sessionId: completedSessionId,
        sequence: 7,
        role: 'tool',
        messageType: 'tool_result',
        providerToolCallId: 'duplicate-call',
        content: toolResult('duplicate-call', 'read', 'duplicate-result-2'),
      },
      {
        id: randomUUID(),
        sessionId: completedSessionId,
        sequence: 8,
        role: 'assistant',
        messageType: 'tool_call',
        providerToolCallId: 'skill-call',
        content: { name: 'use_skill', arguments: { skillId: 'legacy' } },
      },
      {
        id: randomUUID(),
        sessionId: completedSessionId,
        sequence: 9,
        role: 'tool',
        messageType: 'tool_result',
        providerToolCallId: 'skill-call',
        content: toolResult('skill-call', 'use_skill', 'LEGACY_PRIVATE_SKILL_GUIDANCE'),
      },
      {
        id: randomUUID(),
        sessionId: interruptedSessionId,
        sequence: 1,
        role: 'user',
        messageType: 'message',
        content: { message: { role: 'user', content: 'uncommitted-request', timestamp: 20 } },
      },
    ]);

    const restored = await new AgentTranscriptProjector(connection.db).restoreCommitted(run.runId);
    const body = JSON.stringify(restored);
    expect(body).toContain('committed-request');
    expect(body).toContain('verified-result');
    expect(body).toContain('use_skill');
    expect(body).toContain('expired');
    expect(body).not.toContain('uncommitted-request');
    expect(body).not.toContain('orphan-result');
    expect(body).not.toContain('duplicate-result');
    expect(body).not.toContain('LEGACY_PRIVATE_SKILL_GUIDANCE');
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

    const taskOperationKey = `pi-task:${hashToolArguments({
      taskId,
      toolId: 'article.apply_proposal',
      toolVersion: '1.0.0',
      arguments: { proposalId },
      ordinal: 1,
    })}`;
    const proposal = await toolService.propose({
      runId: run.runId,
      taskId,
      taskAttempt: 1,
      taskOperationKey,
      taskOperationOrdinal: 1,
      providerToolCallId,
      toolId: 'article.apply_proposal',
      toolVersion: '1.0.0',
      arguments: { proposalId },
      requestedFromUserId: ids.user,
      allowedCapabilities: new Set(['article.propose']),
      idempotencyKey: taskOperationKey,
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

  it('recovers an expired detached worker and delivers its complete failed TaskResult', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const delegate = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', {
          goal: 'Try an optional detached illustration',
          tasks: [
            {
              ...plannedTask('illustrate-detached', 'illustrator', [], 'optional'),
              detached: true,
            },
          ],
        }),
        toolResponse('task_complete', {
          status: 'failed',
          summary: 'Detached image provider unavailable',
          artifacts: [],
          warnings: ['The article can be delivered without an image'],
          failure: 'image_provider_unavailable',
        }),
        runCompleteResponse('无配图降级交付'),
      ],
    });
    const observedTurns: string[] = [];
    const runtime: AgentRuntime = {
      execute(request, sink, signal) {
        observedTurns.push(request.currentTurn.request);
        return delegate.execute(request, sink, signal);
      },
    };
    const detachedService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await detachedService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: '尝试为文章生成配图，失败时降级交付',
      idempotencyKey: randomUUID(),
    });

    const execution = detachedService.execute(run.runId);
    let detachedTaskId: string | undefined;
    for (let attempt = 0; attempt < 100 && !detachedTaskId; attempt += 1) {
      const rows = await connection.db
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(eq(agentTasks.runId, run.runId));
      detachedTaskId = rows[0]?.id;
      if (!detachedTaskId) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(detachedTaskId).toBeDefined();
    const lostClaim = await connection.db.transaction((transaction) =>
      claimAgentTask(transaction, {
        taskId: detachedTaskId ?? '',
        workerId: 'lost-detached-worker',
        leaseId: randomUUID(),
        leaseToken: randomUUID(),
        leaseMs: 1_000,
        now: new Date('2026-08-04T00:00:00.000Z'),
      }),
    );
    expect(lostClaim?.attempt).toBe(1);
    await expect(
      connection.db.transaction((transaction) =>
        requeueExpiredAgentTasks(transaction, {
          topic: 'agent.task.commands',
          createId: randomUUID,
          now: new Date('2026-08-04T00:00:02.000Z'),
        }),
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({ taskId: detachedTaskId, runId: run.runId }),
    );
    await expect(
      detachedService.executeDetachedTask(run.runId, detachedTaskId ?? ''),
    ).resolves.toBe('failed');
    await expect(execution).resolves.toMatchObject({ status: 'completed_with_degradation' });

    const results = await connection.db
      .select({
        status: taskResults.status,
        attempt: taskResults.attempt,
        summary: taskResults.summary,
        warnings: taskResults.warnings,
        failure: taskResults.failure,
      })
      .from(taskResults)
      .where(eq(taskResults.taskId, detachedTaskId ?? ''));
    expect(results).toEqual([
      {
        status: 'failed',
        attempt: 2,
        summary: 'Detached image provider unavailable',
        warnings: ['The article can be delivered without an image'],
        failure: {
          code: 'image_provider_unavailable',
          message: 'image_provider_unavailable',
        },
      },
    ]);
    const synthesisTurn = observedTurns.find((turn) => turn.includes('validatedTaskResults'));
    expect(synthesisTurn).toContain('Detached image provider unavailable');
    expect(synthesisTurn).toContain('The article can be delivered without an image');
    expect(synthesisTurn).toContain('image_provider_unavailable');
  });

  it('persists a detached wait timeout through the current Task attempt', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        toolResponse('plan_submit', {
          goal: 'Bound detached wait',
          tasks: [
            {
              ...plannedTask('detached-timeout', 'illustrator', [], 'optional'),
              detached: true,
            },
          ],
        }),
        runCompleteResponse('Detached worker timed out; deliver without it.'),
      ],
    });
    const timeoutService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
      detachedTaskWaitTimeoutMs: 200,
    });
    const run = await timeoutService.create({
      conversationId: ids.conversation,
      userId: ids.user,
      branchId,
      prompt: 'Try an optional detached illustration.',
      idempotencyKey: randomUUID(),
    });
    const execution = timeoutService.execute(run.runId);
    let taskId: string | undefined;
    for (let attempt = 0; attempt < 100 && !taskId; attempt += 1) {
      const rows = await connection.db
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(eq(agentTasks.runId, run.runId));
      taskId = rows[0]?.id;
      if (!taskId) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(taskId).toBeDefined();
    await expect(execution).resolves.toMatchObject({ status: 'completed_with_degradation' });

    const resultRows = await connection.db
      .select({
        status: taskResults.status,
        attempt: taskResults.attempt,
        failure: taskResults.failure,
      })
      .from(taskResults)
      .where(eq(taskResults.taskId, taskId ?? ''));
    expect(resultRows).toEqual([
      {
        status: 'failed',
        attempt: 1,
        failure: { code: 'detached_task_timeout', message: 'detached_task_timeout' },
      },
    ]);
    const projection = await timeoutService.getProjection(run.runId);
    expect(
      projection?.parts.some(
        (part) => part.status === 'task.failed' && part.outcome === 'timed_out',
      ),
    ).toBe(true);
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

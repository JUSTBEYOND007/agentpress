import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PiRuntimeAdapter, type AgentRuntime } from '@agentpress/agent-runtime';
import { ProposalService } from '@agentpress/editor-application';
import {
  agentTasks,
  agentRuns,
  agentTaskLeases,
  appUsers,
  artifactEvidence,
  artifacts,
  artifactVersions,
  articles,
  articleRevisions,
  connectDatabase,
  conversationBranches,
  conversations,
  editProposals,
  evidenceRecords,
  executionPlans,
  planRevisions,
  taskResults,
  toolCalls,
  workspaces,
  workspaceMembers,
} from '@agentpress/database';
import { ToolRegistry } from '@agentpress/tool-runtime';
import { Type } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DirectRunService,
  PersistentToolBridge,
  RunProjectionService,
  SpecialistResultStore,
  ToolCallService,
  ToolEvidenceStore,
  type LiveRunEvent,
  type RunEventPublisher,
} from '../src/index.js';
import { projectRunParts } from '../src/run-projection.js';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Multi-Agent durable event chain', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
    branch: randomUUID(),
    article: randomUUID(),
    revision: randomUUID(),
  };
  const published: LiveRunEvent[] = [];
  const publisher: RunEventPublisher = {
    publish(event) {
      published.push(event);
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Multi-Agent chain fixture',
    });
    await connection.db.insert(workspaces).values({ id: ids.workspace, name: 'Chain fixture' });
    await connection.db.insert(workspaceMembers).values({
      workspaceId: ids.workspace,
      userId: ids.user,
      role: 'owner',
    });
    await connection.db.insert(articles).values({
      id: ids.article,
      workspaceId: ids.workspace,
      title: 'Chain article',
    });
    const document = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'chain-block' },
          content: [{ type: 'text', text: 'Original article content' }],
        },
      ],
    };
    await connection.db.insert(articleRevisions).values({
      id: ids.revision,
      articleId: ids.article,
      revisionNumber: 1,
      schemaVersion: 1,
      document,
      documentHash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId: ids.revision })
      .where(eq(articles.id, ids.article));
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      articleId: ids.article,
      title: 'Chain',
    });
    await connection.db.insert(conversationBranches).values({
      id: ids.branch,
      conversationId: ids.conversation,
    });
  });

  afterAll(async () => connection.close());

  it('projects one Plan/Task/Attempt/ToolCall/Evidence/Artifact/Proposal/Settlement chain identically', async () => {
    const registry = new ToolRegistry();
    const proposals = new ProposalService(connection.db);
    registry.register({
      toolId: 'article.evidence_propose',
      version: '1.0.0',
      owner: 'agentpress.fixture',
      description: 'Create a reviewable proposal from a source-backed edit',
      capabilities: ['article.propose'],
      inputSchema: Type.Object({ text: Type.String({ minLength: 1 }) }),
      outputSchema: Type.Object({
        kind: Type.Literal('article_edit_proposal'),
        proposalId: Type.String({ format: 'uuid' }),
        results: Type.Array(
          Type.Object({
            uri: Type.String({ format: 'uri' }),
            title: Type.String(),
            excerpt: Type.String(),
            sourceRevision: Type.String(),
          }),
        ),
      }),
      risk: 'draft_write',
      sideEffect: 'Creates a reviewable edit proposal without mutating the article',
      idempotency: 'provider_key',
      timeoutMs: 10_000,
      estimateCost: () => ({}),
      execute: async ({ text }, context) => {
        const proposal = await proposals.create({
          articleId: ids.article,
          runId: context.runId,
          sourceToolCallId: context.toolCallId,
          baseRevisionId: ids.revision,
          operations: [
            {
              operationId: `fixture-op-${ids.revision}`,
              kind: 'insert',
              afterBlockId: 'chain-block',
              block: {
                type: 'paragraph',
                attrs: { blockId: 'chain-proposal-block' },
                content: [{ type: 'text', text }],
              },
            },
          ],
          reviewMode: 'granular',
        });
        return {
          kind: 'article_edit_proposal' as const,
          proposalId: proposal.proposalId,
          results: [
            {
              uri: 'https://sources.example/chain',
              title: 'Chain source',
              excerpt: 'Evidence used for the proposed edit.',
              sourceRevision: 'sha256:chain-source-v1',
            },
          ],
        };
      },
    });
    const toolService = new ToolCallService({ database: connection.db, registry, publisher });
    const evidence = new ToolEvidenceStore({ database: connection.db });
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: toolService,
    });
    const mainRuntime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall('plan_submit', {
              goal: 'Produce one evidence-backed article proposal',
              tasks: [
                {
                  clientKey: 'chain-editor',
                  owner: 'editor',
                  objective: 'Create an evidence-backed edit proposal',
                  criticality: 'required',
                  acceptanceCriteria: ['Persist one reviewable EditProposal'],
                  dependencyKeys: [],
                  capabilities: ['article.propose'],
                  detached: false,
                },
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
          [
            fauxToolCall('run_complete', {
              answer: 'Evidence-backed proposal is ready for review.',
              artifactIds: [],
              evidenceIds: [],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      ],
    });
    const specialistDelegate = PiRuntimeAdapter.forTests({ responses: [] });
    let fixtureRunId = '';
    const specialistRuntime: AgentRuntime = {
      identity: specialistDelegate.identity,
      execute: async (request, sink, signal) => {
        const brief = JSON.parse(request.currentTurn.request) as {
          readonly task: { readonly id: string };
        };
        const taskId = brief.task.id;
        const operationKey = `fixture:${fixtureRunId}:${taskId}:1`;
        const proposed = await toolService.propose({
          runId: fixtureRunId,
          taskId,
          taskAttempt: 1,
          taskOperationKey: operationKey,
          taskOperationOrdinal: 1,
          providerToolCallId: 'fixture-provider-call',
          toolId: 'article.evidence_propose',
          toolVersion: '1.0.0',
          arguments: { text: 'Evidence-backed article content' },
          requestedFromUserId: ids.user,
          allowedCapabilities: new Set(['article.propose']),
          idempotencyKey: operationKey,
        });
        expect(proposed.status).toBe('proposed');
        await toolService.execute(proposed.toolCallId, signal);
        const references = await evidence.listForToolCall(proposed.toolCallId);
        const completion = PiRuntimeAdapter.forTests({
          responses: [
            fauxAssistantMessage(
              [
                fauxToolCall('task_complete', {
                  status: 'succeeded',
                  summary: 'Evidence-backed proposal persisted.',
                  artifacts: [
                    {
                      type: 'EditProposal',
                      title: 'Evidence-backed edit',
                      summary: 'One source-backed article change.',
                      content: {
                        proposalId: (
                          await connection.db
                            .select({ id: editProposals.id })
                            .from(editProposals)
                            .where(eq(editProposals.sourceToolCallId, proposed.toolCallId))
                            .limit(1)
                        )[0]?.id,
                      },
                      evidenceIds: references.map(({ evidenceId }) => evidenceId),
                    },
                  ],
                  warnings: [],
                }),
              ],
              { stopReason: 'toolUse' },
            ),
          ],
        });
        return completion.execute(request, sink, signal);
      },
    };
    const service = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: (purpose) => (purpose === 'editor' ? specialistRuntime : mainRuntime),
      },
      runtimeToolFactory: bridge,
      systemPrompt: 'You are AgentPress.',
      dispatchCommands: false,
    });
    const run = await service.create({
      conversationId: ids.conversation,
      branchId: ids.branch,
      userId: ids.user,
      prompt: 'Create an evidence-backed article proposal.',
      idempotencyKey: randomUUID(),
    });
    fixtureRunId = run.runId;

    const execution = await service.execute(run.runId);
    expect(execution).toMatchObject({
      runId: run.runId,
      status: 'completed',
    });

    const [
      planRows,
      planRevisionRows,
      taskRows,
      attemptRows,
      callRows,
      evidenceRows,
      artifactRows,
      proposalRows,
      resultRows,
      runRows,
    ] = await Promise.all([
      connection.db.select().from(executionPlans).where(eq(executionPlans.runId, run.runId)),
      connection.db
        .select({ revisionNumber: planRevisions.revisionNumber })
        .from(planRevisions)
        .innerJoin(executionPlans, eq(executionPlans.id, planRevisions.planId))
        .where(eq(executionPlans.runId, run.runId)),
      connection.db.select().from(agentTasks).where(eq(agentTasks.runId, run.runId)),
      connection.db
        .select({ id: agentTaskLeases.id, attempt: agentTaskLeases.attempt })
        .from(agentTaskLeases)
        .innerJoin(agentTasks, eq(agentTasks.id, agentTaskLeases.taskId))
        .where(eq(agentTasks.runId, run.runId)),
      connection.db.select().from(toolCalls).where(eq(toolCalls.runId, run.runId)),
      connection.db.select().from(evidenceRecords).where(eq(evidenceRecords.runId, run.runId)),
      connection.db.select().from(artifacts).where(eq(artifacts.runId, run.runId)),
      connection.db.select().from(editProposals).where(eq(editProposals.runId, run.runId)),
      connection.db
        .select()
        .from(taskResults)
        .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
        .where(eq(agentTasks.runId, run.runId)),
      connection.db
        .select({ finalOutcome: agentRuns.finalOutcome })
        .from(agentRuns)
        .where(eq(agentRuns.id, run.runId)),
    ]);
    expect(planRows).toHaveLength(1);
    expect(planRevisionRows).toEqual([{ revisionNumber: 1 }]);
    expect(taskRows).toMatchObject([{ status: 'succeeded', attempt: 1, owner: 'editor' }]);
    expect(attemptRows.some(({ attempt }) => attempt === 1)).toBe(true);
    expect(callRows).toMatchObject([
      { status: 'succeeded', taskAttempt: 1, taskId: taskRows[0]?.id },
    ]);
    expect(evidenceRows).toMatchObject([
      { sourceToolCallId: callRows[0]?.id, taskId: taskRows[0]?.id },
    ]);
    expect(artifactRows).toMatchObject([{ type: 'EditProposal', taskId: taskRows[0]?.id }]);
    expect(proposalRows).toMatchObject([{ status: 'pending', sourceToolCallId: callRows[0]?.id }]);
    const resultStore = new SpecialistResultStore({
      database: connection.db,
      publisher,
      createId: randomUUID,
      now: () => new Date(),
    });
    await expect(
      resultStore.assertTaskEditProposals(run.runId, taskRows[0]?.id ?? '', [
        proposalRows[0]?.id ?? '',
      ]),
    ).resolves.toBeUndefined();
    await expect(
      resultStore.assertTaskEditProposals(run.runId, randomUUID(), [proposalRows[0]?.id ?? '']),
    ).rejects.toThrow(/not produced for this Task/u);
    expect(resultRows[0]?.task_results).toMatchObject({ status: 'succeeded', attempt: 1 });
    const runUsage = (runRows[0]?.finalOutcome as { usage?: { totalTokens?: number } } | null)
      ?.usage;
    const taskUsage = resultRows[0]?.task_results.usage as { totalTokens?: number };
    expect(runUsage?.totalTokens).toBeGreaterThanOrEqual(taskUsage.totalTokens ?? 0);
    expect(taskUsage.totalTokens).toBeGreaterThan(0);
    const artifactVersionRows = await connection.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifactRows[0]?.id ?? ''));
    expect(artifactVersionRows).toHaveLength(1);
    expect(
      await connection.db
        .select()
        .from(artifactEvidence)
        .where(eq(artifactEvidence.artifactVersionId, artifactVersionRows[0]?.id ?? '')),
    ).toHaveLength(1);

    const durableLiveEvents = published
      .filter(
        (entry): entry is Extract<LiveRunEvent, { readonly durable: true }> =>
          entry.durable && entry.event.runId === run.runId,
      )
      .map(({ event }) => event);
    const replayEvents = await new RunProjectionService(connection.db).listEvents(run.runId);
    expect(projectRunParts(durableLiveEvents)).toEqual(projectRunParts(replayEvents));
    expect(new Set(replayEvents.map(({ eventType }) => eventType))).toEqual(
      new Set([
        'run.queued',
        'run.planning',
        'plan.revised',
        'run.started',
        'task.started',
        'tool.proposed',
        'tool.executing',
        'tool.succeeded',
        'article.proposal.created',
        'task.succeeded',
        'message.completed',
        'run.completed',
      ]),
    );
    const projection = await service.getProjection(run.runId);
    expect(projection?.status).toBe('completed');
    expect(projection?.parts.filter(({ type }) => type === 'evidence')).toHaveLength(1);
    expect(projection?.parts.filter(({ type }) => type === 'artifact')).toHaveLength(1);
    expect(projection?.parts.find(({ type }) => type === 'article-change')).toBeDefined();
  });
});

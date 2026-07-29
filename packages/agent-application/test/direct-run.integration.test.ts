import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PiRuntimeAdapter, type AgentRuntime } from '@agentpress/agent-runtime';
import {
  agentTasks,
  agentRuns,
  appUsers,
  connectDatabase,
  contextPacks,
  conversationBranches,
  conversationMessages,
  conversations,
  executionPlans,
  planRevisions,
  rootRequests,
  runDirectives,
  runEvents,
  taskResults,
  workspaces,
} from '@agentpress/database';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DirectRunService, type LiveRunEvent, type RunEventPublisher } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Direct Run application flow', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
    branch: randomUUID(),
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
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Direct Run',
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
    ).toHaveLength(4);
    expect(published.some((event) => !event.durable)).toBe(true);
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
          await serviceReference.current?.requestCancellation(event.runId);
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
      branchId: cancellationBranch,
      prompt: '开始取消测试',
      idempotencyKey: randomUUID(),
    });

    await expect(cancellationService.execute(run.runId, controller.signal)).resolves.toMatchObject({
      status: 'cancelled',
    });
    const rows = await connection.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    expect(rows[0]?.status).toBe('cancelled');
  });

  it('persists and executes a five-Specialist DAG with isolated Context Packs', async () => {
    const plannedBranch = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: plannedBranch,
      conversationId: ids.conversation,
    });
    const plannedRuntime = PiRuntimeAdapter.forTests({
      responses: [
        '研究结果一',
        '写作草稿一',
        '编辑结果一',
        '核查结果一',
        '配图方案一',
        '研究结果二',
        '写作草稿二',
        '编辑结果二',
        '核查结果二',
        '配图方案二',
        '最终综合文章',
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
      branchId: plannedBranch,
      prompt: '联网搜索最新资料并写一篇图文文章',
      idempotencyKey: randomUUID(),
    });

    expect(run.mode).toBe('planned');
    await plannedService.enqueueSteering(run.runId, '加入性能与成本对比');
    await expect(plannedService.execute(run.runId)).resolves.toMatchObject({
      status: 'completed',
    });

    const tasks = await connection.db
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.runId, run.runId));
    expect(tasks).toHaveLength(10);
    expect(new Set(tasks.map(({ owner }) => owner))).toEqual(
      new Set(['researcher', 'writer', 'editor', 'fact_checker', 'illustrator']),
    );
    expect(tasks.every(({ status }) => status === 'succeeded')).toBe(true);
    const revisions = await connection.db
      .select({ revisionNumber: planRevisions.revisionNumber })
      .from(planRevisions)
      .innerJoin(executionPlans, eq(executionPlans.id, planRevisions.planId))
      .where(eq(executionPlans.runId, run.runId));
    expect(revisions.map(({ revisionNumber }) => revisionNumber)).toEqual([1, 2]);
    const contexts = await connection.db
      .select()
      .from(contextPacks)
      .where(
        inArray(
          contextPacks.taskId,
          tasks.map(({ id }) => id),
        ),
      );
    expect(contexts).toHaveLength(10);
    expect(contexts.every(({ manifest }) => manifest.conversationHistoryIncluded === false)).toBe(
      true,
    );
    const results = await connection.db.select().from(taskResults);
    expect(results.filter(({ taskId }) => tasks.some(({ id }) => id === taskId))).toHaveLength(10);
    const events = await connection.db
      .select({ eventType: runEvents.eventType })
      .from(runEvents)
      .where(eq(runEvents.runId, run.runId));
    expect(events.filter(({ eventType }) => eventType === 'plan.revised')).toHaveLength(2);
    expect(events.some(({ eventType }) => eventType === 'steering.applied')).toBe(true);
  });

  it('rejects Steering for a Direct Run', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const run = await service.create({
      conversationId: ids.conversation,
      branchId,
      prompt: '你好',
      idempotencyKey: randomUUID(),
    });

    await expect(service.enqueueSteering(run.runId, '改变方向')).rejects.toMatchObject({
      code: 'invalid_directive',
    });
  });

  it('fails the Run when a Required Specialist fails', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const runtime: AgentRuntime = {
      execute(request) {
        if (request.systemPrompt.includes('researcher')) {
          return Promise.resolve({
            status: 'failed',
            messages: [],
            error: { code: 'provider_error', message: 'research unavailable', retryable: true },
          });
        }
        return Promise.resolve({
          status: 'completed',
          messages: [assistantMessage(request.runId)],
        });
      },
    };
    const requiredFailureService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await requiredFailureService.create({
      conversationId: ids.conversation,
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
    const serviceReference: { current?: DirectRunService } = {};
    const runtime: AgentRuntime = {
      async execute(request) {
        await serviceReference.current?.requestCancellation(request.runId.split(':')[0] ?? '');
        controller.abort();
        return { status: 'cancelled', messages: [] };
      },
    };
    const cancellationService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    serviceReference.current = cancellationService;
    const run = await cancellationService.create({
      conversationId: ids.conversation,
      branchId,
      prompt: '联网搜索资料并写一篇图文文章',
      idempotencyKey: randomUUID(),
    });

    await expect(cancellationService.execute(run.runId, controller.signal)).resolves.toMatchObject({
      status: 'cancelled',
    });
    const tasks = await connection.db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.runId, run.runId));
    expect(tasks).toHaveLength(5);
    expect(tasks.every(({ status }) => status === 'cancelled')).toBe(true);
  });

  it('recovers a Planned Run through a new immutable Plan Revision', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const recoveryService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: {
        create: () =>
          PiRuntimeAdapter.forTests({
            responses: ['研究', '草稿', '编辑', '核查', '配图', '恢复后的最终文章'],
          }),
      },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await recoveryService.create({
      conversationId: ids.conversation,
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
    await expect(recoveryService.execute(run.runId)).resolves.toMatchObject({
      status: 'completed',
    });
    const revisions = await connection.db
      .select({ reason: planRevisions.reason })
      .from(planRevisions)
      .where(eq(planRevisions.planId, planId));
    expect(revisions.map(({ reason }) => reason)).toEqual(['initial_plan', 'worker_recovery']);
  });

  it('finishes with degradation when only an Optional Specialist fails', async () => {
    const branchId = randomUUID();
    await connection.db.insert(conversationBranches).values({
      id: branchId,
      conversationId: ids.conversation,
    });
    const runtime: AgentRuntime = {
      execute(request) {
        if (request.systemPrompt.includes('illustrator')) {
          return Promise.resolve({
            status: 'failed',
            messages: [],
            error: {
              code: 'provider_error',
              message: 'image provider unavailable',
              retryable: true,
            },
          });
        }
        return Promise.resolve({
          status: 'completed',
          messages: [assistantMessage(request.runId)],
        });
      },
    };
    const degradedService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await degradedService.create({
      conversationId: ids.conversation,
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
    const followUpService = new DirectRunService({
      database: connection.db,
      publisher,
      runtimeFactory: { create: () => runtime },
      systemPrompt: 'You are AgentPress.',
    });
    const run = await followUpService.create({
      conversationId: ids.conversation,
      branchId,
      prompt: '你好',
      idempotencyKey: randomUUID(),
    });
    const firstDirective = await followUpService.enqueueFollowUp(run.runId, '继续补充');
    const secondDirective = await followUpService.enqueueFollowUp(run.runId, '再给一个例子');
    await followUpService.execute(run.runId);

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
  return {
    role: 'assistant' as const,
    content: `result:${seed}`,
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

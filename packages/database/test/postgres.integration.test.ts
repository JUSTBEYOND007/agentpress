import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentRuns,
  agentTaskLeases,
  agentTasks,
  claimAgentTask,
  appendRunEvent,
  cancelAgentRunTasks,
  appUsers,
  claimOutboxMessages,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  enqueueOutboxMessage,
  inboxMessages,
  markOutboxMessagePublished,
  decideMemoryCandidate,
  deleteMemoryCandidate,
  exportMemoryCandidates,
  listAcceptedMemory,
  memoryCandidates,
  outboxMessages,
  proposeMemoryCandidate,
  processInboxMessage,
  rootRequests,
  runDirectives,
  runEvents,
  runToolChoices,
  taskResults,
  ToolChoiceQueueStore,
  workspaces,
  workspaceMembers,
  executionPlans,
  planRevisions,
  reclaimExpiredAgentTasks,
  requeueExpiredAgentTasks,
  releaseAgentTaskLease,
  renewAgentTaskLease,
  settleAgentTaskAttempt,
} from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('PostgreSQL runtime persistence', () => {
  const connection = connectDatabase(connectionString ?? '');
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    conversation: randomUUID(),
    branch: randomUUID(),
    message: randomUUID(),
    request: randomUUID(),
    run: randomUUID(),
    plan: randomUUID(),
    revision: randomUUID(),
    task: randomUUID(),
  };

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `logto|${ids.user}`,
      displayName: 'Integration User',
    });
    await connection.db.insert(workspaces).values({ id: ids.workspace, name: 'Integration' });
    await connection.db
      .insert(workspaceMembers)
      .values({ userId: ids.user, workspaceId: ids.workspace, role: 'owner' });
    await connection.db
      .insert(conversations)
      .values({ id: ids.conversation, workspaceId: ids.workspace, title: 'Test' });
    await connection.db
      .insert(conversationBranches)
      .values({ id: ids.branch, conversationId: ids.conversation });
    await connection.db.insert(conversationMessages).values({
      id: ids.message,
      branchId: ids.branch,
      role: 'user',
      sequence: 1,
      content: [{ type: 'text', text: 'test' }],
      stable: true,
    });
    await connection.db.insert(rootRequests).values({
      id: ids.request,
      branchId: ids.branch,
      messageId: ids.message,
      idempotencyKey: `request:${ids.request}`,
    });
    await connection.db.insert(agentRuns).values({
      id: ids.run,
      workspaceId: ids.workspace,
      branchId: ids.branch,
      rootRequestId: ids.request,
      mode: 'planned',
      status: 'queued',
    });
    await connection.db.insert(executionPlans).values({ id: ids.plan, runId: ids.run });
    await connection.db.insert(planRevisions).values({
      id: ids.revision,
      planId: ids.plan,
      revisionNumber: 1,
      reason: 'integration',
      summary: 'integration',
    });
    await connection.db.insert(agentTasks).values({
      id: ids.task,
      runId: ids.run,
      planRevisionId: ids.revision,
      objective: 'lease task',
      criticality: 'required',
      owner: 'researcher',
      acceptanceCriteria: ['returns'],
      outputSchema: { type: 'object' },
      toolPolicy: { capabilities: [] },
      budget: {},
      status: 'pending',
      maxAttempts: 3,
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('deduplicates inbox processing in the same transaction as domain work', async () => {
    const envelope = {
      consumerGroup: `integration-worker-${ids.run}`,
      messageId: randomUUID(),
      topic: 'agent.run.commands',
      partition: 0,
      offset: 1,
      payloadHash: 'sha256:message',
    };
    let calls = 0;
    const handler = (): Promise<void> => {
      calls += 1;
      return Promise.resolve();
    };

    expect(await processInboxMessage(connection.db, envelope, handler)).toBe('processed');
    expect(await processInboxMessage(connection.db, envelope, handler)).toBe('duplicate');
    expect(calls).toBe(1);
    expect(
      await connection.db
        .select()
        .from(inboxMessages)
        .where(eq(inboxMessages.messageId, envelope.messageId)),
    ).toHaveLength(1);
  });

  it('enforces at most one active Run on a Conversation branch', async () => {
    const messageId = randomUUID();
    const requestId = randomUUID();
    await connection.db.insert(conversationMessages).values({
      id: messageId,
      branchId: ids.branch,
      role: 'user',
      sequence: 2,
      content: [{ type: 'text', text: 'second run' }],
      stable: true,
    });
    await connection.db.insert(rootRequests).values({
      id: requestId,
      branchId: ids.branch,
      messageId,
      idempotencyKey: `request:${requestId}`,
    });

    await expect(
      connection.db.insert(agentRuns).values({
        id: randomUUID(),
        workspaceId: ids.workspace,
        branchId: ids.branch,
        rootRequestId: requestId,
        mode: 'direct',
        status: 'queued',
      }),
    ).rejects.toMatchObject({
      cause: {
        code: '23505',
        constraint: 'agent_runs_one_active_per_branch_unique',
      },
    });
  });

  it('claims, publishes and sequences durable events without duplicates', async () => {
    const outboxId = randomUUID();
    await connection.db.transaction(async (transaction) => {
      await enqueueOutboxMessage(transaction, {
        id: outboxId,
        aggregateType: 'AgentRun',
        aggregateId: ids.run,
        topic: 'agent.run.events',
        messageKey: ids.run,
        payload: { type: 'run.queued' },
        occurredAt: new Date(),
      });
    });

    const claimed = await claimOutboxMessages(connection.db, 'worker-1', 1_000);
    expect(claimed.map(({ id }) => id)).toContain(outboxId);
    expect(await markOutboxMessagePublished(connection.db, outboxId, 'worker-1', new Date())).toBe(
      true,
    );
    expect(
      (await claimOutboxMessages(connection.db, 'worker-2', 1_000)).map(({ id }) => id),
    ).not.toContain(outboxId);
    const events = await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        connection.db.transaction((transaction) =>
          appendRunEvent(transaction, {
            id: randomUUID(),
            runId: ids.run,
            eventType: 'run.tested',
            payload: { index },
          }),
        ),
      ),
    );
    expect(events.map(({ sequence }) => sequence).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(
      await connection.db.select().from(runEvents).where(eq(runEvents.runId, ids.run)),
    ).toHaveLength(8);
  });

  it('claims a task once, recovers an expired lease, and never reclaims a settled task', async () => {
    const first = await connection.db.transaction((transaction) =>
      claimAgentTask(transaction, {
        taskId: ids.task,
        workerId: 'task-worker-1',
        leaseId: randomUUID(),
        leaseToken: randomUUID(),
        leaseMs: 1_000,
        now: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );
    expect(first?.attempt).toBe(1);
    const duplicate = await connection.db.transaction((transaction) =>
      claimAgentTask(transaction, {
        taskId: ids.task,
        workerId: 'task-worker-2',
        leaseId: randomUUID(),
        leaseToken: randomUUID(),
        leaseMs: 1_000,
        now: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );
    expect(duplicate).toBeUndefined();
    expect(
      await renewAgentTaskLease(connection.db, {
        leaseToken: first?.lease.leaseToken ?? '',
        workerId: 'task-worker-1',
        leaseMs: 1_000,
        now: new Date('2026-01-01T00:00:00.500Z'),
      }),
    ).toBe(true);
    expect(
      await reclaimExpiredAgentTasks(connection.db, new Date('2026-01-01T00:00:02.000Z')),
    ).toEqual([ids.task]);
    const second = await connection.db.transaction((transaction) =>
      claimAgentTask(transaction, {
        taskId: ids.task,
        workerId: 'task-worker-2',
        leaseId: randomUUID(),
        leaseToken: randomUUID(),
        leaseMs: 1_000,
        now: new Date('2026-01-01T00:00:02.000Z'),
      }),
    );
    expect(second?.attempt).toBe(2);
    expect(
      await connection.db.transaction((transaction) =>
        settleAgentTaskAttempt(transaction, {
          taskId: ids.task,
          attempt: 1,
          status: 'succeeded',
          now: new Date('2026-01-01T00:00:02.050Z'),
        }),
      ),
    ).toBe(false);
    expect(
      await connection.db.transaction((transaction) =>
        settleAgentTaskAttempt(transaction, {
          taskId: ids.task,
          attempt: 2,
          status: 'succeeded',
          now: new Date('2026-01-01T00:00:02.075Z'),
        }),
      ),
    ).toBe(true);
    await releaseAgentTaskLease(connection.db, {
      leaseToken: second?.lease.leaseToken ?? '',
      workerId: 'task-worker-2',
      now: new Date('2026-01-01T00:00:02.100Z'),
    });
    await connection.db.insert(taskResults).values({
      id: randomUUID(),
      taskId: ids.task,
      attempt: 2,
      status: 'succeeded',
      summary: 'Second attempt completed',
      artifacts: [],
      evidence: [],
      usage: {},
      warnings: [],
    });
    await connection.db
      .update(agentTasks)
      .set({ status: 'interrupted' })
      .where(eq(agentTasks.id, ids.task));
    expect(
      await connection.db.transaction((transaction) =>
        claimAgentTask(transaction, {
          taskId: ids.task,
          workerId: 'task-worker-3',
          leaseId: randomUUID(),
          leaseToken: randomUUID(),
          leaseMs: 1_000,
        }),
      ),
    ).toBeUndefined();
    expect(
      await connection.db
        .select()
        .from(agentTaskLeases)
        .where(eq(agentTaskLeases.taskId, ids.task)),
    ).toHaveLength(2);
  });

  it('cancels a claimed Task, releases its lease, and fences a late worker result', async () => {
    const taskId = randomUUID();
    await connection.db.insert(agentTasks).values({
      id: taskId,
      runId: ids.run,
      planRevisionId: ids.revision,
      objective: 'cancelled lease task',
      criticality: 'required',
      owner: 'writer',
      acceptanceCriteria: ['does not settle after cancellation'],
      outputSchema: { type: 'object' },
      toolPolicy: { capabilities: [] },
      budget: {},
      status: 'pending',
      maxAttempts: 3,
    });
    const claim = await connection.db.transaction((transaction) =>
      claimAgentTask(transaction, {
        taskId,
        workerId: 'cancelled-task-worker',
        leaseId: randomUUID(),
        leaseToken: randomUUID(),
        leaseMs: 10_000,
      }),
    );
    expect(claim?.attempt).toBe(1);

    const cancelled = await connection.db.transaction((transaction) =>
      cancelAgentRunTasks(transaction, {
        runId: ids.run,
        now: new Date('2026-08-04T00:00:00.000Z'),
      }),
    );
    expect(cancelled).toContainEqual({ taskId, attempt: 1 });
    await expect(
      connection.db.transaction((transaction) =>
        settleAgentTaskAttempt(transaction, {
          taskId,
          attempt: 1,
          status: 'succeeded',
        }),
      ),
    ).resolves.toBe(false);
    const [taskRows, leaseRows, resultRows] = await Promise.all([
      connection.db
        .select({ status: agentTasks.status })
        .from(agentTasks)
        .where(eq(agentTasks.id, taskId)),
      connection.db
        .select({ releasedAt: agentTaskLeases.releasedAt })
        .from(agentTaskLeases)
        .where(eq(agentTaskLeases.taskId, taskId)),
      connection.db.select().from(taskResults).where(eq(taskResults.taskId, taskId)),
    ]);
    expect(taskRows).toEqual([{ status: 'cancelled' }]);
    expect(leaseRows[0]?.releasedAt).toEqual(new Date('2026-08-04T00:00:00.000Z'));
    expect(resultRows).toEqual([]);
  });

  it('requeues an expired Task lease exactly once and allows a new attempt', async () => {
    const taskId = randomUUID();
    await connection.db.insert(agentTasks).values({
      id: taskId,
      runId: ids.run,
      planRevisionId: ids.revision,
      objective: 'recover expired detached task',
      criticality: 'required',
      owner: 'researcher',
      acceptanceCriteria: ['returns on the next attempt'],
      outputSchema: { type: 'object' },
      toolPolicy: { capabilities: [] },
      budget: {},
      status: 'pending',
      maxAttempts: 3,
    });
    const first = await connection.db.transaction((transaction) =>
      claimAgentTask(transaction, {
        taskId,
        workerId: 'lost-task-worker',
        leaseId: randomUUID(),
        leaseToken: randomUUID(),
        leaseMs: 1_000,
        now: new Date('2026-08-04T00:00:00.000Z'),
      }),
    );
    expect(first?.attempt).toBe(1);
    const recoveredAt = new Date('2026-08-04T00:00:02.000Z');
    const requeued = await connection.db.transaction((transaction) =>
      requeueExpiredAgentTasks(transaction, {
        topic: 'agent.task.commands',
        createId: randomUUID,
        now: recoveredAt,
      }),
    );
    expect(requeued).toEqual([{ taskId, runId: ids.run }]);
    await expect(
      connection.db.transaction((transaction) =>
        requeueExpiredAgentTasks(transaction, {
          topic: 'agent.task.commands',
          createId: randomUUID,
          now: recoveredAt,
        }),
      ),
    ).resolves.toEqual([]);
    const commands = await connection.db
      .select({ payload: outboxMessages.payload })
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, taskId));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload).toMatchObject({
      command: 'task.execute',
      runId: ids.run,
      taskId,
    });
    const second = await connection.db.transaction((transaction) =>
      claimAgentTask(transaction, {
        taskId,
        workerId: 'recovered-task-worker',
        leaseId: randomUUID(),
        leaseToken: randomUUID(),
        leaseMs: 1_000,
        now: recoveredAt,
      }),
    );
    expect(second?.attempt).toBe(2);
  });

  it('persists and recovers forced tool choices without crossing directive semantics', async () => {
    const now = new Date('2026-08-04T00:00:00.000Z');
    const store = new ToolChoiceQueueStore(connection.db, randomUUID, () => now);
    const [first, second] = await Promise.all([
      store.enqueue({
        runId: ids.run,
        choice: { type: 'tool', name: 'run_complete' },
        label: 'first',
      }),
      store.enqueue({ runId: ids.run, choice: 'required', label: 'second' }),
    ]);
    expect([first.sequence, second.sequence].sort((left, right) => left - right)).toEqual([1, 2]);

    const steeringId = randomUUID();
    await connection.db.insert(runDirectives).values({
      id: steeringId,
      runId: ids.run,
      sequence: 1,
      kind: 'steering',
      content: 'change direction',
    });
    await expect(
      store.claimNext({ runId: ids.run, claimToken: randomUUID() }),
    ).resolves.toBeUndefined();
    await connection.db
      .update(runDirectives)
      .set({ status: 'consumed' })
      .where(eq(runDirectives.id, steeringId));
    await connection.db.insert(runDirectives).values({
      id: randomUUID(),
      runId: ids.run,
      sequence: 2,
      kind: 'follow_up',
      content: 'continue later',
    });

    const firstToken = randomUUID();
    const claimed = await store.claimNext({ runId: ids.run, claimToken: firstToken });
    expect(claimed?.label).toBe(first.sequence === 1 ? 'first' : 'second');
    await expect(
      store.claimNext({ runId: ids.run, claimToken: randomUUID() }),
    ).resolves.toBeUndefined();
    await expect(
      store.settle({
        id: claimed?.id ?? '',
        claimToken: randomUUID(),
        status: 'resolved',
      }),
    ).resolves.toBe(false);

    expect(await store.requeueInFlight(ids.run)).toBe(1);
    await expect(
      store.settle({ id: claimed?.id ?? '', claimToken: firstToken, status: 'resolved' }),
    ).resolves.toBe(false);
    const recoveredToken = randomUUID();
    const recovered = await store.claimNext({ runId: ids.run, claimToken: recoveredToken });
    expect(recovered?.id).toBe(claimed?.id);
    await expect(
      store.settle({ id: recovered?.id ?? '', claimToken: recoveredToken, status: 'resolved' }),
    ).resolves.toBe(true);

    expect(await store.cancelRun(ids.run)).toBe(1);
    const rows = await connection.db
      .select({ status: runToolChoices.status, recoveryCount: runToolChoices.recoveryCount })
      .from(runToolChoices)
      .where(eq(runToolChoices.runId, ids.run));
    expect(rows.map(({ status }) => status).sort()).toEqual(['cancelled', 'resolved']);
    expect(rows.find(({ status }) => status === 'resolved')?.recoveryCount).toBe(1);
  });

  it('persists confirmed memory and isolates retrieval by workspace and user', async () => {
    const first = await proposeMemoryCandidate(connection.db, {
      id: randomUUID(),
      workspaceId: ids.workspace,
      userId: ids.user,
      subject: 'writing_style',
      value: 'concise',
      valueHash: 'sha256:concise',
      confidenceBps: 9000,
      kind: 'preference',
      importanceBps: 8000,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      sourceEvidenceIds: ['evidence-1'],
    });
    expect(
      await listAcceptedMemory(connection.db, { workspaceId: ids.workspace, userId: ids.user }),
    ).toEqual([]);
    expect(
      await decideMemoryCandidate(connection.db, {
        id: first.id,
        workspaceId: ids.workspace,
        userId: ids.user,
        decision: 'accepted',
      }),
    ).toMatchObject({
      status: 'accepted',
      kind: 'preference',
      importanceBps: 8000,
      sourceEvidenceIds: ['evidence-1'],
    });
    const replacement = await proposeMemoryCandidate(connection.db, {
      id: randomUUID(),
      workspaceId: ids.workspace,
      userId: ids.user,
      subject: 'writing_style',
      value: 'detailed',
      valueHash: 'sha256:detailed',
      confidenceBps: 8500,
      supersedesId: first.id,
      sourceRunId: ids.run,
      sourceEvidenceIds: ['sensitive-evidence'],
    });
    await decideMemoryCandidate(connection.db, {
      id: replacement.id,
      workspaceId: ids.workspace,
      userId: ids.user,
      decision: 'accepted',
    });
    const expired = await proposeMemoryCandidate(connection.db, {
      id: randomUUID(),
      workspaceId: ids.workspace,
      userId: ids.user,
      subject: 'expired_fact',
      value: 'historical',
      valueHash: 'sha256:historical',
      confidenceBps: 7000,
      validUntil: new Date('2026-01-01T00:00:00.000Z'),
    });
    await decideMemoryCandidate(connection.db, {
      id: expired.id,
      workspaceId: ids.workspace,
      userId: ids.user,
      decision: 'accepted',
    });
    expect(
      await listAcceptedMemory(connection.db, {
        workspaceId: ids.workspace,
        userId: ids.user,
        now: new Date('2026-08-04T00:00:00.000Z'),
      }),
    ).toHaveLength(1);
    expect(
      await listAcceptedMemory(connection.db, { workspaceId: randomUUID(), userId: ids.user }),
    ).toEqual([]);
    expect(
      await deleteMemoryCandidate(connection.db, {
        id: replacement.id,
        workspaceId: randomUUID(),
        userId: ids.user,
      }),
    ).toBeUndefined();
    await expect(
      deleteMemoryCandidate(connection.db, {
        id: replacement.id,
        workspaceId: ids.workspace,
        userId: ids.user,
        deletedAt: new Date('2026-08-04T01:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      status: 'deleted',
      value: '[deleted]',
      sourceRunId: null,
      sourceEvidenceIds: [],
    });
    const exported = await exportMemoryCandidates(connection.db, {
      workspaceId: ids.workspace,
      userId: ids.user,
    });
    expect(exported.some(({ id }) => id === replacement.id)).toBe(false);
    expect(JSON.stringify(exported)).not.toContain('sensitive-evidence');
    await expect(
      connection.db.select().from(memoryCandidates).where(eq(memoryCandidates.id, replacement.id)),
    ).resolves.toMatchObject([
      {
        status: 'deleted',
        value: '[deleted]',
        sourceRunId: null,
        sourceToolCallId: null,
        sourceEvidenceIds: [],
      },
    ]);
  });
});

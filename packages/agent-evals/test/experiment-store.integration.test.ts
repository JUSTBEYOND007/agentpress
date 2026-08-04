import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  actionProposals,
  agentRuns,
  agentTasks,
  appUsers,
  approvals,
  articleRevisions,
  articles,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  editProposalBatches,
  editProposalDecisions,
  editProposals,
  evalArms,
  evalExperiments,
  evalRunTraces,
  evalTrials,
  evidenceRecords,
  executionPlans,
  planRevisions,
  rootRequests,
  runEvents,
  taskResults,
  toolCalls,
  workspaces,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExperimentStore } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('evaluation experiment persistence', () => {
  const connection = connectDatabase(connectionString ?? '');

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('persists versioned arms, atomic trials, metrics, and a redacted trace', async () => {
    const store = new ExperimentStore(connection.db);
    const experimentName = `routing-${randomUUID()}`;
    const workspaceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    await connection.db.insert(workspaces).values([
      { id: workspaceId, name: 'Eval workspace' },
      { id: foreignWorkspaceId, name: 'Foreign workspace' },
    ]);
    const created = await store.createExperiment({
      workspaceId,
      name: experimentName,
      datasetVersion: 'routing@1',
      config: { sandbox: 'isolated-schema' },
      arms: [
        {
          name: 'baseline',
          model: 'provider/model',
          promptVersion: 'main@1',
          skillVersions: { research: '1.0.0' },
          toolPolicyVersion: 'tools@1',
          contextPolicyVersion: 'context@1',
        },
      ],
    });
    const trialIds = await store.enqueueTrials({
      armId: created.armIds[0] ?? '',
      caseIds: ['routing-01'],
      attempts: 2,
      seed: 'fixed-seed',
    });
    expect(trialIds).toHaveLength(2);
    expect(await store.startExperiment(created.experimentId)).toBe(true);
    expect(await store.startExperiment(created.experimentId)).toBe(false);
    const firstClaim = await store.claimTrial({
      trialId: trialIds[0] ?? '',
      workerId: 'eval-worker-1',
      claimToken: randomUUID(),
      leaseMs: 60_000,
    });
    expect(firstClaim).toBeDefined();
    expect(
      await store.claimTrial({
        trialId: trialIds[0] ?? '',
        workerId: 'eval-worker-2',
        claimToken: randomUUID(),
        leaseMs: 60_000,
      }),
    ).toBeUndefined();
    expect(
      await store.settleTrial({
        trialId: trialIds[0] ?? '',
        claimToken: firstClaim?.claimToken ?? '',
        status: 'succeeded',
        resultMetrics: { succeeded: true, schemaValid: true },
        processMetrics: { duplicateSideEffects: 0 },
      }),
    ).toBe(true);
    const secondClaim = await store.claimTrial({
      trialId: trialIds[1] ?? '',
      workerId: 'eval-worker-1',
      claimToken: randomUUID(),
      leaseMs: 60_000,
    });
    expect(secondClaim).toBeDefined();
    expect(
      await store.settleTrial({
        trialId: trialIds[1] ?? '',
        claimToken: secondClaim?.claimToken ?? '',
        status: 'failed',
        failure: { code: 'runtime_error' },
      }),
    ).toBe(true);
    const retryId = await store.retryTrial({ trialId: trialIds[1] ?? '', seed: 'fixed-seed' });
    expect(retryId).toBeDefined();
    const traceId = await store.persistTrace(trialIds[0] ?? '', [
      { type: 'run.started', payload: { apiKey: 'secret', timestamp: 1 } },
      { type: 'run.completed', payload: { timestamp: 2 } },
    ]);
    await expect(
      connection.db
        .select()
        .from(evalExperiments)
        .where(eq(evalExperiments.id, created.experimentId)),
    ).resolves.toHaveLength(1);
    await expect(
      connection.db
        .select()
        .from(evalArms)
        .where(eq(evalArms.id, created.armIds[0] ?? '')),
    ).resolves.toHaveLength(1);
    const trials = await connection.db
      .select()
      .from(evalTrials)
      .where(eq(evalTrials.id, trialIds[0] ?? ''));
    expect(trials[0]).toMatchObject({ status: 'succeeded', seed: 'fixed-seed:routing-01:1' });
    const traces = await connection.db
      .select()
      .from(evalRunTraces)
      .where(eq(evalRunTraces.id, traceId));
    expect(traces[0]?.redactedTrace).toEqual([
      { type: 'run.started', payload: { apiKey: '[REDACTED]', timestamp: 1 } },
      { type: 'run.completed', payload: { timestamp: 2 } },
    ]);
    const report = await store.getExperimentReport(created.experimentId);
    expect(report?.arms[0]).toMatchObject({
      name: 'baseline',
      totalTrials: 3,
      decidedTrials: 2,
      passedTrials: 1,
      failedTrials: 1,
      traceCount: 1,
    });
    await expect(store.getTrialTrace(trialIds[0] ?? '')).resolves.toMatchObject({
      traceHash: traces[0]?.traceHash,
      events: [
        { type: 'run.started', payload: { apiKey: '[REDACTED]', timestamp: 1 } },
        { type: 'run.completed', payload: { timestamp: 2 } },
      ],
    });
    await expect(
      store.getWorkspaceExperimentReport(workspaceId, created.experimentId),
    ).resolves.toMatchObject({ id: created.experimentId });
    await expect(store.listWorkspaceExperiments(workspaceId)).resolves.toEqual([
      expect.objectContaining({ id: created.experimentId, name: experimentName }),
    ]);
    await expect(store.listWorkspaceExperiments(foreignWorkspaceId)).resolves.toEqual([]);
    await expect(
      store.getWorkspaceExperimentReport(foreignWorkspaceId, created.experimentId),
    ).resolves.toBeUndefined();
    await expect(
      store.getWorkspaceTrialTrace(workspaceId, trialIds[0] ?? ''),
    ).resolves.toMatchObject({ traceHash: traces[0]?.traceHash });
    await expect(
      store.getWorkspaceTrialTrace(foreignWorkspaceId, trialIds[0] ?? ''),
    ).resolves.toBeUndefined();
    await expect(
      store.listRegressionTrend({
        workspaceId,
        experimentName,
        arm: 'baseline',
        metricKey: 'succeeded',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        experimentId: created.experimentId,
        datasetVersion: 'routing@1',
        value: 0.5,
      }),
    ]);
    await expect(
      store.listRegressionTrend({
        workspaceId: foreignWorkspaceId,
        experimentName,
        arm: 'baseline',
        metricKey: 'succeeded',
      }),
    ).resolves.toEqual([]);
    expect(await store.cancelExperiment(created.experimentId)).toBe(true);
    const retry = await connection.db
      .select({ status: evalTrials.status, attempt: evalTrials.attempt })
      .from(evalTrials)
      .where(eq(evalTrials.id, retryId ?? ''));
    expect(retry).toEqual([{ status: 'cancelled', attempt: 3 }]);
    const succeeded = await connection.db
      .select({ status: evalTrials.status })
      .from(evalTrials)
      .where(eq(evalTrials.id, trialIds[0] ?? ''));
    expect(succeeded).toEqual([{ status: 'succeeded' }]);
  });

  it('captures the complete persisted Run fact chain without copying sensitive bodies', async () => {
    const store = new ExperimentStore(connection.db);
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const conversationId = randomUUID();
    const branchId = randomUUID();
    const messageId = randomUUID();
    const requestId = randomUUID();
    const runId = randomUUID();
    const planId = randomUUID();
    const planRevisionId = randomUUID();
    const taskId = randomUUID();
    const toolCallId = randomUUID();
    const articleId = randomUUID();
    const revisionId = randomUUID();
    const editProposalId = randomUUID();
    const startedAt = new Date('2026-08-04T01:00:00.000Z');
    const settledAt = new Date('2026-08-04T01:00:01.000Z');

    await connection.db.transaction(async (transaction) => {
      await transaction.insert(workspaces).values({ id: workspaceId, name: 'Trace workspace' });
      await transaction.insert(appUsers).values({
        id: userId,
        logtoSubject: `trace:${userId}`,
        displayName: 'Trace evaluator',
      });
      await transaction.insert(conversations).values({
        id: conversationId,
        workspaceId,
        title: 'Trace conversation',
      });
      await transaction.insert(conversationBranches).values({ id: branchId, conversationId });
      await transaction.insert(conversationMessages).values({
        id: messageId,
        branchId,
        role: 'user',
        sequence: 1,
        content: [{ type: 'text', text: 'evaluate' }],
        stable: true,
      });
      await transaction.insert(rootRequests).values({
        id: requestId,
        branchId,
        messageId,
        requestedByUserId: userId,
        idempotencyKey: `trace:${requestId}`,
      });
      await transaction.insert(agentRuns).values({
        id: runId,
        workspaceId,
        branchId,
        rootRequestId: requestId,
        mode: 'planned',
        status: 'running',
      });
      await transaction.insert(runEvents).values([
        {
          id: randomUUID(),
          runId,
          sequence: 1,
          eventType: 'run.started',
          payload: { apiKey: 'raw-key', note: 'Bearer opaque-token' },
          createdAt: startedAt,
        },
        {
          id: randomUUID(),
          runId,
          sequence: 2,
          eventType: 'run.completed',
          payload: { usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.01 } },
          createdAt: settledAt,
        },
      ]);
      await transaction.insert(executionPlans).values({ id: planId, runId });
      await transaction.insert(planRevisions).values({
        id: planRevisionId,
        planId,
        revisionNumber: 1,
        reason: 'initial',
        summary: 'Evaluate persisted facts',
      });
      await transaction.insert(agentTasks).values({
        id: taskId,
        runId,
        planRevisionId,
        objective: 'Collect evidence',
        criticality: 'required',
        owner: 'researcher',
        acceptanceCriteria: ['Evidence persisted'],
        outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
        toolPolicy: { allow: ['knowledge.search'] },
        budget: { maxCalls: 2 },
        status: 'succeeded',
        attempt: 1,
        completedAt: settledAt,
      });
      await transaction.insert(taskResults).values({
        id: randomUUID(),
        taskId,
        attempt: 1,
        status: 'succeeded',
        summary: 'done',
        artifacts: [{ id: 'artifact-secret-body' }],
        evidence: [{ id: 'evidence-secret-body' }],
        usage: { inputTokens: 2, outputTokens: 1 },
        warnings: [],
        createdAt: settledAt,
      });
      await transaction.insert(toolCalls).values({
        id: toolCallId,
        runId,
        taskId,
        providerToolCallId: 'provider-call-1',
        toolId: 'knowledge.search',
        toolVersion: '1.0.0',
        arguments: { query: 'private body', apiKey: 'tool-secret' },
        argumentsHash: 'arguments-hash',
        risk: 'read_only',
        sideEffect: 'none',
        idempotencyKey: 'private-idempotency-key',
        status: 'succeeded',
        output: { answer: 'private output', token: 'output-secret' },
        settledAt,
      });
      await transaction.insert(approvals).values({
        id: randomUUID(),
        toolCallId,
        requestedFromUserId: userId,
        decidedByUserId: userId,
        decision: 'approved',
        toolVersion: '1.0.0',
        argumentsHash: 'arguments-hash',
        displayedSideEffect: 'none',
        estimatedCost: { usd: 0 },
        expiresAt: new Date('2026-08-04T02:00:00.000Z'),
        decidedAt: settledAt,
      });
      await transaction.insert(evidenceRecords).values({
        id: randomUUID(),
        runId,
        taskId,
        sourceType: 'knowledge',
        sourceUri: 'https://example.com/private',
        title: 'Private title',
        excerpt: 'Private excerpt',
        sourceRevision: 'knowledge@1',
        contentHash: 'evidence-content-hash',
        metadata: { apiKey: 'metadata-secret' },
      });
      await transaction.insert(articles).values({ id: articleId, workspaceId, title: 'Trace' });
      await transaction.insert(articleRevisions).values({
        id: revisionId,
        articleId,
        revisionNumber: 1,
        schemaVersion: 1,
        document: { type: 'doc', content: [] },
        documentHash: 'document-hash',
        source: 'manual',
        createdByUserId: userId,
      });
      await transaction.insert(actionProposals).values({
        id: randomUUID(),
        sourceRunId: runId,
        articleId,
        baseRevisionId: revisionId,
        requestedByUserId: userId,
        instruction: 'Private instruction',
        summary: 'Private summary',
        selectedBlocks: [{ blockId: 'block-1', contentHash: 'block-hash' }],
        grantedCapabilities: ['article.edit'],
        status: 'rejected',
        expiresAt: new Date('2026-08-04T02:00:00.000Z'),
      });
      await transaction.insert(editProposals).values({
        id: editProposalId,
        articleId,
        runId,
        baseRevisionId: revisionId,
        operations: [{ operationId: 'operation-1', replacement: 'Private replacement' }],
        diffs: [{ before: 'private', after: 'private' }],
        reviewMode: 'granular',
        sourceToolCallId: toolCallId,
        status: 'accepted',
        expiresAt: new Date('2026-08-04T02:00:00.000Z'),
      });
      await transaction.insert(editProposalBatches).values({
        id: randomUUID(),
        proposalId: editProposalId,
        runId,
        batchNumber: 1,
        operations: [{ operationId: 'operation-1', replacement: 'Private replacement' }],
        diffs: [{ before: 'private', after: 'private' }],
        beforeHash: 'before-hash',
        afterHash: 'after-hash',
        status: 'active',
      });
      await transaction.insert(editProposalDecisions).values({
        proposalId: editProposalId,
        operationId: 'operation-1',
        decision: 'accepted',
        decidedByUserId: userId,
        decidedAt: settledAt,
      });
    });

    const created = await store.createExperiment({
      workspaceId,
      name: `persisted-trace-${randomUUID()}`,
      datasetVersion: 'trace@1',
      config: {},
      arms: [
        {
          name: 'baseline',
          model: 'provider/model',
          promptVersion: 'main@1',
          skillVersions: {},
          toolPolicyVersion: 'tools@1',
          contextPolicyVersion: 'context@1',
        },
      ],
    });
    const [trialId] = await store.enqueueTrials({
      armId: created.armIds[0] ?? '',
      caseIds: ['trace-case'],
      attempts: 1,
      seed: 'trace-seed',
    });
    await store.startExperiment(created.experimentId);
    const claim = await store.claimTrial({
      trialId: trialId ?? '',
      workerId: 'trace-worker',
      claimToken: randomUUID(),
      leaseMs: 60_000,
      runId,
    });
    await expect(store.capturePersistedTrialTrace(trialId ?? '')).rejects.toThrow(/must settle/u);
    await expect(
      store.settleTrial({
        trialId: trialId ?? '',
        claimToken: claim?.claimToken ?? '',
        status: 'succeeded',
        resultMetrics: { succeeded: true },
      }),
    ).rejects.toThrow(/Agent Run is terminal/u);
    await connection.db
      .update(agentRuns)
      .set({ status: 'completed', completedAt: settledAt })
      .where(eq(agentRuns.id, runId));
    await store.settleTrial({
      trialId: trialId ?? '',
      claimToken: claim?.claimToken ?? '',
      status: 'succeeded',
      resultMetrics: { succeeded: true },
    });

    const trace = await store.getTrialTrace(trialId ?? '');
    expect(trace?.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        'run.started',
        'run.completed',
        'task.fact',
        'task.settlement',
        'tool.settlement',
        'approval.settlement',
        'evidence.persisted',
        'action_proposal.settlement',
        'edit_proposal.settlement',
        'proposal_batch.settlement',
        'proposal_operation.settlement',
      ]),
    );
    const serialized = JSON.stringify(trace?.events);
    expect(serialized).not.toContain('raw-key');
    expect(serialized).not.toContain('opaque-token');
    expect(serialized).not.toContain('private body');
    expect(serialized).not.toContain('private output');
    expect(serialized).not.toContain('Private excerpt');
    expect(serialized).not.toContain('Private replacement');
    expect(serialized).toContain('[REDACTED]');
  });

  it('fences an expired worker and retries in a fresh sandbox', async () => {
    let now = new Date('2026-08-04T00:00:00.000Z');
    const store = new ExperimentStore(connection.db, randomUUID, () => now);
    const created = await store.createExperiment({
      name: `lease-recovery-${randomUUID()}`,
      datasetVersion: 'lease-recovery@1',
      config: {},
      arms: [
        {
          name: 'candidate',
          model: 'provider/model',
          promptVersion: 'main@1',
          skillVersions: {},
          toolPolicyVersion: 'tools@1',
          contextPolicyVersion: 'context@1',
        },
      ],
    });
    const [trialId] = await store.enqueueTrials({
      armId: created.armIds[0] ?? '',
      caseIds: ['case-lease'],
      attempts: 1,
      seed: 'fixed-seed',
    });
    expect(await store.startExperiment(created.experimentId)).toBe(true);
    const staleToken = randomUUID();
    await expect(
      store.claimTrial({
        trialId: trialId ?? '',
        workerId: 'lost-eval-worker',
        claimToken: staleToken,
        leaseMs: 1_000,
      }),
    ).resolves.toBeDefined();
    const firstSandbox = await store.getTrialSandboxDescriptor(trialId ?? '');

    now = new Date('2026-08-04T00:00:02.000Z');
    await expect(store.failExpiredTrials(created.experimentId)).resolves.toEqual([trialId]);
    await expect(
      store.settleTrial({
        trialId: trialId ?? '',
        claimToken: staleToken,
        status: 'succeeded',
        resultMetrics: { succeeded: true },
      }),
    ).resolves.toBe(false);
    const retryId = await store.retryTrial({ trialId: trialId ?? '', seed: 'fixed-seed' });
    expect(retryId).toBeDefined();
    const retrySandbox = await store.getTrialSandboxDescriptor(retryId ?? '');
    expect(retrySandbox?.trialId).toBe(retryId);
    expect(retrySandbox?.databaseSchema).not.toBe(firstSandbox?.databaseSchema);
    expect(retrySandbox?.objectPrefix).not.toBe(firstSandbox?.objectPrefix);
    expect(retrySandbox?.kafkaConsumerGroup).not.toBe(firstSandbox?.kafkaConsumerGroup);

    const retryClaim = await store.claimTrial({
      trialId: retryId ?? '',
      workerId: 'replacement-eval-worker',
      claimToken: randomUUID(),
      leaseMs: 1_000,
    });
    expect(retryClaim).toBeDefined();
    await expect(
      store.settleTrial({
        trialId: retryId ?? '',
        claimToken: retryClaim?.claimToken ?? '',
        status: 'succeeded',
        resultMetrics: { succeeded: true },
      }),
    ).resolves.toBe(true);
    const trials = await connection.db
      .select({
        attempt: evalTrials.attempt,
        status: evalTrials.status,
        failure: evalTrials.failure,
      })
      .from(evalTrials)
      .where(eq(evalTrials.armId, created.armIds[0] ?? ''));
    expect(trials).toEqual(
      expect.arrayContaining([
        {
          attempt: 1,
          status: 'failed',
          failure: { code: 'worker_lease_expired', category: 'runtime' },
        },
        { attempt: 2, status: 'succeeded', failure: null },
      ]),
    );
  });

  it('claims concurrent pending Trials with PostgreSQL SKIP LOCKED', async () => {
    const store = new ExperimentStore(connection.db);
    const created = await store.createExperiment({
      name: `parallel-claim-${randomUUID()}`,
      datasetVersion: 'parallel@1',
      config: {},
      arms: [
        {
          name: 'baseline',
          model: 'provider/model',
          promptVersion: 'main@1',
          skillVersions: {},
          toolPolicyVersion: 'tools@1',
          contextPolicyVersion: 'context@1',
        },
      ],
    });
    await store.enqueueTrials({
      armId: created.armIds[0] ?? '',
      caseIds: ['case-a', 'case-b'],
      attempts: 1,
      seed: 'parallel-seed',
    });
    await expect(store.startExperiment(created.experimentId)).resolves.toBe(true);
    const [first, second] = await Promise.all([
      store.claimNextTrial({
        experimentId: created.experimentId,
        workerId: 'parallel-worker-1',
        claimToken: randomUUID(),
        leaseMs: 60_000,
      }),
      store.claimNextTrial({
        experimentId: created.experimentId,
        workerId: 'parallel-worker-2',
        claimToken: randomUUID(),
        leaseMs: 60_000,
      }),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.trialId).not.toBe(second?.trialId);
    expect(new Set([first?.workerId, second?.workerId])).toEqual(
      new Set(['parallel-worker-1', 'parallel-worker-2']),
    );
  });
});

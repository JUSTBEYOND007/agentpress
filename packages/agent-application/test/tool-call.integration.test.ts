import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  agentRuns,
  agentTasks,
  appUsers,
  approvals,
  artifacts,
  artifactVersions,
  checkpoints,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  executionPlans,
  evidenceRecords,
  planRevisions,
  rootRequests,
  runEvents,
  runSkillBindings,
  skillRevisions,
  toolCalls,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { hashToolArguments, ToolExecutionError, ToolRegistry } from '@agentpress/tool-runtime';
import { Type } from '@sinclair/typebox';
import { and, asc, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DirectRunService,
  PersistentToolBridge,
  RunProjectionService,
  ToolEvidenceStore,
  ToolCallService,
  ToolTransportAuditService,
  type LiveRunEvent,
} from '../src/index.js';
import { projectRunParts } from '../src/run-projection.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Tool Call application flow', () => {
  const connection = connectDatabase(connectionString ?? '');
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const published: LiveRunEvent[] = [];
  const registry = new ToolRegistry();
  let searchExecutions = 0;
  let hangingReadExecutions = 0;
  let webSearchExecutions = 0;
  let externalExecutions = 0;
  let hangingExternalExecutions = 0;
  let delayedExternalExecutions = 0;
  let successfulExternalExecutions = 0;
  let finishDelayedPublish: ((output: { readonly publicationId: string }) => void) | undefined;
  registry.register({
    toolId: 'workspace.search',
    version: '1.0.0',
    owner: 'workspace',
    description: 'Search workspace',
    guidance: [{ id: 'bounded-query', text: 'Use one focused query.' }],
    capabilities: ['workspace.read'],
    inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }),
    risk: 'read_only',
    sideEffect: 'No side effect',
    idempotency: 'none',
    timeoutMs: 1_000,
    estimateCost: () => ({}),
    execute: ({ query }) => {
      searchExecutions += 1;
      return Promise.resolve({ result: query });
    },
  });
  registry.register({
    toolId: 'workspace.uncertain_search',
    version: '1.0.0',
    owner: 'workspace',
    description: 'Search through a connection that may be interrupted',
    capabilities: ['workspace.read'],
    inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }),
    risk: 'read_only',
    sideEffect: 'No side effect',
    idempotency: 'none',
    timeoutMs: 1_000,
    estimateCost: () => ({}),
    execute: () => {
      throw new ToolExecutionError(
        'Connection was lost after dispatch',
        'unknown',
        'connection_lost_after_dispatch',
      );
    },
  });
  registry.register({
    toolId: 'workspace.hanging_search',
    version: '1.0.0',
    owner: 'workspace',
    description: 'Search through a provider that ignores cancellation',
    capabilities: ['workspace.read'],
    inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }),
    risk: 'read_only',
    sideEffect: 'No side effect',
    idempotency: 'none',
    timeoutMs: 20,
    estimateCost: () => ({}),
    execute: () => {
      hangingReadExecutions += 1;
      return new Promise<{ readonly result: string }>(() => undefined);
    },
  });
  registry.register({
    toolId: 'workspace.secret_failure',
    version: '1.0.0',
    owner: 'workspace',
    description: 'Fail with protected provider diagnostics',
    capabilities: ['workspace.read'],
    inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }),
    risk: 'read_only',
    sideEffect: 'No side effect',
    idempotency: 'none',
    timeoutMs: 1_000,
    estimateCost: () => ({}),
    execute: () => {
      throw new Error('provider credential=super-secret stack=/private/runtime.ts:42');
    },
  });
  registry.register({
    toolId: 'web.search',
    version: '1.0.0',
    owner: 'research',
    description: 'Search public sources',
    transport: {
      kind: 'mcp',
      serverId: 'web_research',
      serverRevision: '1.0.0',
      toolName: 'search',
      toolRevision: '1.0.0',
      adapterRevision: 'agentpress-mcp-adapter-v1',
    },
    evidence: { providerRevision: 'anysearch-api-v1+pi-web-access-v0.15.0' },
    capabilities: ['web.research'],
    inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Array(Type.Unknown()),
    risk: 'read_only',
    sideEffect: 'No side effect',
    idempotency: 'none',
    timeoutMs: 1_000,
    estimateCost: () => ({}),
    execute: () => {
      webSearchExecutions += 1;
      return Promise.resolve([
        {
          source: 'AnySearch',
          url: 'https://example.com/source',
          title: 'Primary source',
          text: 'Citable source text',
        },
      ]);
    },
  });
  registry.register({
    toolId: 'publication.delayed_publish',
    version: '1.0.0',
    owner: 'publication',
    description: 'Publish an edition through a delayed provider',
    capabilities: ['publication.write'],
    inputSchema: Type.Object({ editionId: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ publicationId: Type.String() }, { additionalProperties: false }),
    risk: 'external_write',
    sideEffect: 'Publish the selected immutable edition',
    idempotency: 'provider_key',
    timeoutMs: 1_000,
    estimateCost: () => ({ credits: 1 }),
    execute: () => {
      delayedExternalExecutions += 1;
      return new Promise<{ readonly publicationId: string }>((resolve) => {
        finishDelayedPublish = resolve;
      });
    },
  });
  registry.register({
    toolId: 'publication.hanging_publish',
    version: '1.0.0',
    owner: 'publication',
    description: 'Publish through a provider that ignores cancellation',
    capabilities: ['publication.write'],
    inputSchema: Type.Object({ editionId: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ publicationId: Type.String() }, { additionalProperties: false }),
    risk: 'external_write',
    sideEffect: 'Publish the selected immutable edition',
    idempotency: 'provider_key',
    timeoutMs: 20,
    estimateCost: () => ({ credits: 1 }),
    execute: () => {
      hangingExternalExecutions += 1;
      return new Promise<{ readonly publicationId: string }>(() => undefined);
    },
  });
  registry.register({
    toolId: 'publication.successful_publish',
    version: '1.0.0',
    owner: 'publication',
    description: 'Publish an edition through a successful provider',
    capabilities: ['publication.write'],
    inputSchema: Type.Object({ editionId: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ publicationId: Type.String() }, { additionalProperties: false }),
    risk: 'external_write',
    sideEffect: 'Publish the selected immutable edition',
    idempotency: 'provider_key',
    timeoutMs: 1_000,
    estimateCost: () => ({ credits: 1 }),
    execute: () => {
      successfulExternalExecutions += 1;
      return Promise.resolve({ publicationId: randomUUID() });
    },
  });
  registry.register({
    toolId: 'publication.publish',
    version: '1.0.0',
    owner: 'publication',
    description: 'Publish an edition',
    capabilities: ['publication.write'],
    inputSchema: Type.Object({ editionId: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ publicationId: Type.String() }, { additionalProperties: false }),
    risk: 'external_write',
    sideEffect: 'Publish the selected immutable edition',
    idempotency: 'provider_key',
    timeoutMs: 1_000,
    estimateCost: () => ({ credits: 1 }),
    execute: () => {
      externalExecutions += 1;
      throw new ToolExecutionError('Provider response was lost', 'unknown');
    },
  });
  const service = new ToolCallService({
    database: connection.db,
    registry,
    publisher: {
      publish(event) {
        published.push(event);
        return Promise.resolve();
      },
    },
  });

  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await connection.db.insert(appUsers).values({
      id: userId,
      logtoSubject: `logto|${userId}`,
      displayName: 'Tool User',
    });
    await connection.db.insert(workspaces).values({ id: workspaceId, name: 'Tool Workspace' });
    await connection.db.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
    await connection.db.insert(conversations).values({
      id: conversationId,
      workspaceId,
      title: 'Tool Calls',
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('executes a validated read-only Tool Call and checkpoints settlement', async () => {
    const runId = await createRunningRun();
    const proposal = await service.propose({
      runId,
      toolId: 'workspace.search',
      toolVersion: '1.0.0',
      arguments: { query: 'AgentPress' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['workspace.read']),
    });
    expect(proposal.status).toBe('proposed');
    await expect(service.execute(proposal.toolCallId)).resolves.toMatchObject({
      status: 'succeeded',
      output: { result: 'AgentPress' },
    });
    await expect(service.execute(proposal.toolCallId)).rejects.toMatchObject({
      code: 'invalid_tool_state',
    });
    const saved = await connection.db
      .select({ reason: checkpoints.reason })
      .from(checkpoints)
      .where(eq(checkpoints.runId, runId));
    expect(saved).toEqual([{ reason: 'tool_settled' }]);
  });

  it('fails closed when the persisted evidence provider revision drifts', async () => {
    const runId = await createRunningRun();
    const proposal = await service.propose({
      runId,
      toolId: 'web.search',
      toolVersion: '1.0.0',
      arguments: { query: 'revision drift' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['web.research']),
    });
    await connection.db
      .update(toolCalls)
      .set({ evidenceProviderRevision: 'retired-provider-revision' })
      .where(eq(toolCalls.id, proposal.toolCallId));

    await expect(service.execute(proposal.toolCallId)).rejects.toMatchObject({
      code: 'approval_mismatch',
    });
    await expect(
      connection.db
        .select({ status: toolCalls.status })
        .from(toolCalls)
        .where(eq(toolCalls.id, proposal.toolCallId)),
    ).resolves.toEqual([{ status: 'proposed' }]);
  });

  it('snapshots MCP transport provenance in the Tool Call and proposed event', async () => {
    const runId = await createRunningRun();
    const idempotencyKey = `web-search:${randomUUID()}`;
    const input = {
      runId,
      toolId: 'web.search',
      toolVersion: '1.0.0',
      arguments: { query: 'transport provenance' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['web.research']),
      idempotencyKey,
    } as const;
    const proposal = await service.propose(input);
    const replay = await service.propose(input);
    expect(replay.toolCallId).toBe(proposal.toolCallId);

    const expectedTransport = {
      kind: 'mcp',
      serverId: 'web_research',
      serverRevision: '1.0.0',
      toolName: 'search',
      toolRevision: '1.0.0',
      adapterRevision: 'agentpress-mcp-adapter-v1',
    } as const;
    await expect(
      connection.db
        .select({
          transportProvenance: toolCalls.transportProvenance,
          argumentSummary: toolCalls.argumentSummary,
        })
        .from(toolCalls)
        .where(eq(toolCalls.id, proposal.toolCallId)),
    ).resolves.toEqual([
      {
        transportProvenance: expectedTransport,
        argumentSummary: {
          schemaVersion: 1,
          fieldCount: 1,
          additionalFieldCount: 0,
          fields: [
            {
              name: 'query',
              required: true,
              schemaTypes: ['string'],
              valueType: 'string',
              stringLength: 20,
            },
          ],
        },
      },
    ]);
    const events = await connection.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.eventType, 'tool.proposed')));
    expect(events).toMatchObject([
      {
        payload: {
          transportProvenance: expectedTransport,
          argumentSummary: {
            schemaVersion: 1,
            fieldCount: 1,
            additionalFieldCount: 0,
            fields: [
              {
                name: 'query',
                required: true,
                schemaTypes: ['string'],
                valueType: 'string',
                stringLength: 20,
              },
            ],
          },
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('transport provenance');

    await connection.db
      .update(toolCalls)
      .set({ transportProvenance: { ...expectedTransport, serverRevision: '2.0.0' } })
      .where(eq(toolCalls.id, proposal.toolCallId));
    await expect(service.propose(input)).rejects.toMatchObject({ code: 'approval_mismatch' });
  });

  it('fails closed before provider execution when MCP transport provenance drifts', async () => {
    const runId = await createRunningRun();
    const proposal = await service.propose({
      runId,
      toolId: 'web.search',
      toolVersion: '1.0.0',
      arguments: { query: 'transport drift' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['web.research']),
    });
    await connection.db
      .update(toolCalls)
      .set({
        transportProvenance: {
          kind: 'mcp',
          serverId: 'web_research',
          serverRevision: 'retired-revision',
          toolName: 'search',
          toolRevision: '1.0.0',
          adapterRevision: 'agentpress-mcp-adapter-v1',
        },
      })
      .where(eq(toolCalls.id, proposal.toolCallId));
    const before = webSearchExecutions;

    await expect(service.execute(proposal.toolCallId)).rejects.toMatchObject({
      code: 'approval_mismatch',
    });
    expect(webSearchExecutions).toBe(before);
    await expect(
      connection.db
        .select({ status: toolCalls.status })
        .from(toolCalls)
        .where(eq(toolCalls.id, proposal.toolCallId)),
    ).resolves.toEqual([{ status: 'proposed' }]);
  });

  it('persists idempotent MCP reconnect audit facts with live and replay parity', async () => {
    const publishedFrom = published.length;
    const transportAudit = new ToolTransportAuditService({
      database: connection.db,
      publisher: {
        publish(event) {
          published.push(event);
          return Promise.resolve();
        },
      },
    });
    const auditResults: { readonly persisted: boolean }[] = [];
    registry.register({
      toolId: 'web.audited_search',
      version: '1.0.0',
      owner: 'research',
      description: 'Search with a reconnect audit fixture',
      transport: {
        kind: 'mcp',
        serverId: 'web_research',
        serverRevision: '1.0.0',
        toolName: 'search',
        toolRevision: '1.0.0',
        adapterRevision: 'agentpress-mcp-adapter-v1',
      },
      capabilities: ['web.research'],
      inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }),
      risk: 'read_only',
      sideEffect: 'No side effect',
      idempotency: 'none',
      timeoutMs: 1_000,
      estimateCost: () => ({}),
      execute: async (_input, context) => {
        const retry = {
          runId: context.runId,
          toolCallId: context.toolCallId,
          serverId: 'web_research',
          toolName: 'search',
          retryOrdinal: 1,
          phase: 'before_dispatch',
          reason: 'connect_failure',
        } as const;
        auditResults.push(await transportAudit.record({ ...retry, event: 'retry_attempted' }));
        auditResults.push(await transportAudit.record({ ...retry, event: 'retry_attempted' }));
        auditResults.push(
          await transportAudit.record({ ...retry, event: 'retry_attempted', retryOrdinal: 2 }),
        );
        auditResults.push(
          await transportAudit.record({ ...retry, event: 'reconnected', retryOrdinal: 2 }),
        );
        auditResults.push(
          await transportAudit.record({ ...retry, event: 'reconnected', retryOrdinal: 2 }),
        );
        return { result: 'ok' };
      },
    });
    const runId = await createRunningRun();
    const proposal = await service.propose({
      runId,
      toolId: 'web.audited_search',
      toolVersion: '1.0.0',
      arguments: { query: 'retry audit' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['web.research']),
    });

    await expect(service.execute(proposal.toolCallId)).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(auditResults).toMatchObject([
      { persisted: true },
      { persisted: false },
      { persisted: true },
      { persisted: true },
      { persisted: false },
    ]);
    await expect(
      connection.db
        .select({
          retryCount: toolCalls.transportRetryCount,
          reconnectCount: toolCalls.transportReconnectCount,
        })
        .from(toolCalls)
        .where(eq(toolCalls.id, proposal.toolCallId)),
    ).resolves.toEqual([{ retryCount: 2, reconnectCount: 1 }]);
    const auditEvents = await connection.db
      .select({ eventType: runEvents.eventType, payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.sequence));
    expect(
      auditEvents.filter(({ eventType }) => eventType.startsWith('tool.transport_')),
    ).toMatchObject([
      {
        eventType: 'tool.transport_retrying',
        payload: { transportRetryCount: 1, transportReconnectCount: 0 },
      },
      {
        eventType: 'tool.transport_retrying',
        payload: { transportRetryCount: 2, transportReconnectCount: 0 },
      },
      {
        eventType: 'tool.transport_reconnected',
        payload: { transportRetryCount: 2, transportReconnectCount: 1 },
      },
    ]);
    const liveEvents = published
      .slice(publishedFrom)
      .flatMap((event) => (event.durable && event.event.runId === runId ? [event.event] : []));
    const livePart = projectRunParts(liveEvents).find(
      ({ correlationId }) => correlationId === `tool:${proposal.toolCallId}`,
    );
    const replay = await new RunProjectionService(connection.db).get(runId);
    const replayPart = replay?.parts.find(
      ({ correlationId }) => correlationId === `tool:${proposal.toolCallId}`,
    );
    expect(replayPart).toEqual(livePart);
    expect(replayPart?.payload).toMatchObject({
      transportRetryCount: 2,
      transportReconnectCount: 1,
    });
  });

  it('rolls back succeeded settlement when Evidence projection fails', async () => {
    const runId = await createRunningRun();
    const failingService = new ToolCallService({
      database: connection.db,
      registry,
      publisher: {
        publish(event) {
          published.push(event);
          return Promise.resolve();
        },
      },
      evidenceProjector: () => Promise.reject(new Error('injected Evidence persistence failure')),
    });
    const proposal = await failingService.propose({
      runId,
      toolId: 'web.search',
      toolVersion: '1.0.0',
      arguments: { query: 'atomic settlement' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['web.research']),
    });

    await expect(failingService.execute(proposal.toolCallId)).rejects.toThrow(
      'injected Evidence persistence failure',
    );
    await expect(
      connection.db
        .select({ status: toolCalls.status })
        .from(toolCalls)
        .where(eq(toolCalls.id, proposal.toolCallId)),
    ).resolves.toEqual([{ status: 'executing' }]);
    await expect(
      connection.db
        .select({ id: evidenceRecords.id })
        .from(evidenceRecords)
        .where(eq(evidenceRecords.sourceToolCallId, proposal.toolCallId)),
    ).resolves.toEqual([]);
    const terminalFacts = await connection.db
      .select({ eventType: runEvents.eventType })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.eventType, 'tool.succeeded')));
    expect(terminalFacts).toEqual([]);
  });

  it('settles an interrupted read-only provider call as outcome unknown', async () => {
    const publishedFrom = published.length;
    const runId = await createRunningRun();
    const proposal = await service.propose({
      runId,
      toolId: 'workspace.uncertain_search',
      toolVersion: '1.0.0',
      arguments: { query: 'interrupted' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['workspace.read']),
    });

    await expect(service.execute(proposal.toolCallId)).resolves.toMatchObject({
      status: 'outcome_unknown',
    });
    const rows = await connection.db
      .select({ status: toolCalls.status })
      .from(toolCalls)
      .where(eq(toolCalls.id, proposal.toolCallId));
    expect(rows).toEqual([{ status: 'outcome_unknown' }]);
    const liveEvents = published
      .slice(publishedFrom)
      .flatMap((event) => (event.durable && event.event.runId === runId ? [event.event] : []));
    const liveParts = projectRunParts(liveEvents).filter(
      ({ status }) => status === 'tool.outcome_unknown',
    );
    const replay = await new RunProjectionService(connection.db).get(runId);
    const replayParts = replay?.parts.filter(({ status }) => status === 'tool.outcome_unknown');
    expect(replayParts).toEqual(liveParts);
    expect(replayParts).toHaveLength(1);
    expect(replayParts?.[0]).toMatchObject({
      type: 'warning',
      status: 'tool.outcome_unknown',
      outcome: 'outcome_unknown',
      payload: {
        failure: {
          code: 'outcome_unknown',
          messageKey: 'tool.failure.outcome_unknown',
          retryable: false,
          outcomeReason: 'connection_lost_after_dispatch',
        },
      },
    });
  });

  it('enforces hard deadlines with risk-aware ToolCall settlement', async () => {
    const publishedFrom = published.length;
    const runId = await createRunningRun();
    const readBefore = hangingReadExecutions;
    const read = await service.propose({
      runId,
      toolId: 'workspace.hanging_search',
      toolVersion: '1.0.0',
      arguments: { query: 'hard deadline' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['workspace.read']),
    });
    await expect(service.execute(read.toolCallId)).resolves.toMatchObject({ status: 'failed' });
    expect(hangingReadExecutions - readBefore).toBe(1);

    const externalBefore = hangingExternalExecutions;
    const publish = await service.propose({
      runId,
      toolId: 'publication.hanging_publish',
      toolVersion: '1.0.0',
      arguments: { editionId: randomUUID() },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['publication.write']),
      idempotencyKey: `publish:${randomUUID()}`,
    });
    await service.decideApproval({
      toolCallId: publish.toolCallId,
      decision: 'approved',
      userId,
    });
    await expect(service.execute(publish.toolCallId)).resolves.toMatchObject({
      status: 'outcome_unknown',
    });
    expect(hangingExternalExecutions - externalBefore).toBe(1);

    const rows = await connection.db
      .select({ id: toolCalls.id, status: toolCalls.status, failure: toolCalls.failure })
      .from(toolCalls)
      .where(eq(toolCalls.runId, runId));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: read.toolCallId,
          status: 'failed',
          failure: expect.objectContaining({
            code: 'tool_timeout',
            messageKey: 'tool.failure.timeout',
            retryable: true,
            visibility: 'protected',
          }) as unknown,
        }),
        expect.objectContaining({
          id: publish.toolCallId,
          status: 'outcome_unknown',
          failure: expect.objectContaining({
            code: 'outcome_unknown',
            messageKey: 'tool.failure.outcome_unknown',
            retryable: false,
            outcomeReason: 'timeout_after_dispatch',
            visibility: 'protected',
          }) as unknown,
        }),
      ]),
    );
    const liveEvents = published
      .slice(publishedFrom)
      .flatMap((event) => (event.durable && event.event.runId === runId ? [event.event] : []));
    const replay = await new RunProjectionService(connection.db).get(runId);
    expect(replay?.parts).toEqual(projectRunParts(liveEvents));
    expect(
      replay?.parts.find(
        ({ status, payload }) => status === 'tool.failed' && payload.toolCallId === read.toolCallId,
      ),
    ).toMatchObject({
      outcome: 'failed',
      payload: { failure: { code: 'tool_timeout', retryable: true } },
    });
    expect(
      replay?.parts.find(
        ({ status, payload }) =>
          status === 'tool.outcome_unknown' && payload.toolCallId === publish.toolCallId,
      ),
    ).toMatchObject({
      outcome: 'outcome_unknown',
      payload: {
        failure: {
          code: 'outcome_unknown',
          retryable: false,
          outcomeReason: 'timeout_after_dispatch',
        },
      },
    });
    expect(JSON.stringify(liveEvents)).not.toContain('Tool publication.hanging_publish');
  });

  it('keeps provider diagnostics protected while live and replay expose one public failure', async () => {
    const publishedFrom = published.length;
    const runId = await createRunningRun();
    const proposal = await service.propose({
      runId,
      toolId: 'workspace.secret_failure',
      toolVersion: '1.0.0',
      arguments: { query: 'failure boundary' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['workspace.read']),
    });

    await expect(service.execute(proposal.toolCallId)).resolves.toMatchObject({ status: 'failed' });
    const [saved] = await connection.db
      .select({ failure: toolCalls.failure })
      .from(toolCalls)
      .where(eq(toolCalls.id, proposal.toolCallId));
    expect(saved?.failure).toMatchObject({
      code: 'provider_failed',
      messageKey: 'tool.failure.provider',
      retryable: true,
      visibility: 'protected',
    });
    expect(saved?.failure?.message).toContain('super-secret');

    const liveEvents = published
      .slice(publishedFrom)
      .flatMap((event) => (event.durable && event.event.runId === runId ? [event.event] : []));
    const liveParts = projectRunParts(liveEvents).filter(({ type }) => type === 'activity');
    const replay = await new RunProjectionService(connection.db).get(runId);
    const replayParts = replay?.parts.filter(({ type }) => type === 'activity');
    expect(replayParts).toEqual(liveParts);
    expect(replayParts).toHaveLength(1);
    expect(replayParts?.[0]).toMatchObject({
      status: 'tool.failed',
      payload: {
        failure: {
          code: 'provider_failed',
          messageKey: 'tool.failure.provider',
          retryable: true,
        },
      },
    });
    expect(JSON.stringify(liveEvents)).not.toContain('super-secret');
    expect(JSON.stringify(replayParts)).not.toContain('/private/runtime.ts');
  });

  it('bridges a Pi Runtime tool through the persistent ledger', async () => {
    const runId = await createRunningRun();
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: service,
    });
    const tools = await bridge.createForRun(runId, ['workspace.read']);
    const search = tools.find((tool) => tool.label === 'workspace.search');
    expect(search?.description).toContain(
      'workspace.search@1.0.0 (bounded-query): Use one focused query.',
    );
    await expect(
      search?.execute({ query: 'durable tool' }, { runId, providerToolCallId: randomUUID() }),
    ).resolves.toEqual({ result: 'durable tool' });
    const rows = await connection.db
      .select({ status: toolCalls.status })
      .from(toolCalls)
      .where(eq(toolCalls.runId, runId));
    expect(rows).toEqual([{ status: 'succeeded' }]);
  });

  it('projects live durable ToolCall events identically to PostgreSQL replay', async () => {
    const publishedFrom = published.length;
    const runId = await createRunningRun();
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: service,
    });
    const search = (await bridge.createForRun(runId, ['workspace.read'])).find(
      (tool) => tool.label === 'workspace.search',
    );
    await search?.execute(
      { query: 'live replay equality' },
      { runId, providerToolCallId: randomUUID() },
    );

    const liveEvents = published
      .slice(publishedFrom)
      .flatMap((event) => (event.durable && event.event.runId === runId ? [event.event] : []));
    const liveParts = projectRunParts(liveEvents).filter(({ type }) => type === 'activity');
    const replay = await new RunProjectionService(connection.db).get(runId);
    const replayById = new Map(replay?.parts.map((part) => [part.id, part]));
    expect(liveParts.map((part) => replayById.get(part.id))).toEqual(liveParts);
    expect(liveParts).toEqual([
      expect.objectContaining({ status: 'tool.succeeded', outcome: 'succeeded' }),
    ]);
  });

  it('links the result URL Evidence to its exact Specialist Tool Call attempt', async () => {
    const runId = await createRunningRun();
    const taskId = await createRunningTask(runId, 1);
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: service,
    });
    const search = (await bridge.createForRun(runId, ['web.research'], taskId, 1)).find(
      (tool) => tool.label === 'web.search',
    );

    const providerToolCallId = randomUUID();
    await search?.execute({ query: 'source URI' }, { runId, providerToolCallId });
    await search?.execute({ query: 'source URI' }, { runId, providerToolCallId });

    const rows = await connection.db
      .select({
        sourceUri: evidenceRecords.sourceUri,
        sourceToolCallId: evidenceRecords.sourceToolCallId,
        providerRevision: toolCalls.evidenceProviderRevision,
        taskAttempt: toolCalls.taskAttempt,
      })
      .from(evidenceRecords)
      .innerJoin(toolCalls, eq(toolCalls.id, evidenceRecords.sourceToolCallId))
      .where(eq(evidenceRecords.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceUri: 'https://example.com/source',
      providerRevision: 'anysearch-api-v1+pi-web-access-v0.15.0',
      taskAttempt: 1,
    });
    expect(rows[0]?.sourceToolCallId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('recovers Evidence from an oversized ToolOutput Artifact idempotently', async () => {
    const runId = await createRunningRun();
    const taskId = await createRunningTask(runId, 1);
    const proposal = await service.propose({
      runId,
      taskId,
      taskAttempt: 1,
      providerToolCallId: randomUUID(),
      toolId: 'web.search',
      toolVersion: '1.0.0',
      arguments: { query: 'artifact source' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['web.research']),
    });
    const artifactId = randomUUID();
    const versionId = randomUUID();
    await connection.db.transaction(async (transaction) => {
      await transaction.insert(artifacts).values({
        id: artifactId,
        runId,
        taskId,
        type: 'ToolOutput',
        title: `Tool output ${proposal.toolCallId}`,
      });
      await transaction.insert(artifactVersions).values({
        id: versionId,
        artifactId,
        version: 1,
        summary: 'Oversized web search output',
        content: {
          toolCallId: proposal.toolCallId,
          output: [
            {
              url: 'https://example.com/artifact-source',
              title: 'Artifact source',
              text: 'Evidence recovered from durable oversized output.',
            },
          ],
        },
        contentHash: createHash('sha256').update(versionId).digest('hex'),
      });
    });
    const evidence = new ToolEvidenceStore({ database: connection.db });
    const input = {
      runId,
      taskId,
      toolCallId: proposal.toolCallId,
      toolId: 'web.search',
      toolVersion: '1.0.0',
      output: { value: { artifactId } },
    } as const;

    const first = await evidence.persist(input);
    const replay = await evidence.persist(input);

    expect(first).toHaveLength(1);
    expect(replay).toEqual(first);
    expect(first[0]).toMatchObject({
      source: 'https://example.com/artifact-source',
      title: 'Artifact source',
    });
    const rows = await connection.db
      .select({ sourceToolCallId: evidenceRecords.sourceToolCallId })
      .from(evidenceRecords)
      .where(eq(evidenceRecords.runId, runId));
    expect(rows).toEqual([{ sourceToolCallId: proposal.toolCallId }]);
  });

  it('replays a settled provider Tool Call without executing its side effect twice', async () => {
    const publishedFrom = published.length;
    const runId = await createRunningRun();
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: service,
    });
    const search = (await bridge.createForRun(runId, ['workspace.read'])).find(
      (tool) => tool.label === 'workspace.search',
    );
    const providerToolCallId = randomUUID();
    const before = searchExecutions;
    await expect(
      search?.execute({ query: 'replay-safe' }, { runId, providerToolCallId }),
    ).resolves.toEqual({ result: 'replay-safe' });
    await expect(
      search?.execute({ query: 'replay-safe' }, { runId, providerToolCallId }),
    ).resolves.toEqual({ result: 'replay-safe' });
    expect(searchExecutions - before).toBe(1);
    const duplicateEvents = published
      .slice(publishedFrom)
      .flatMap((event) =>
        event.durable && event.event.eventType === 'tool.duplicate_result_ignored'
          ? [event.event]
          : [],
      );
    expect(duplicateEvents).toHaveLength(1);
    expect(duplicateEvents[0]?.payload).toMatchObject({ reason: 'idempotency_replay' });
    const replay = await new RunProjectionService(connection.db).get(runId);
    expect(replay?.parts.some(({ status }) => status === 'tool.duplicate_result_ignored')).toBe(
      false,
    );
  });

  it('cancels undispatched Tool Calls and removes stale approvals from replay', async () => {
    const publishedFrom = published.length;
    const runId = await createRunningRun();
    const search = await service.propose({
      runId,
      toolId: 'workspace.search',
      toolVersion: '1.0.0',
      arguments: { query: 'cancel before dispatch' },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['workspace.read']),
    });
    const publish = await service.propose({
      runId,
      toolId: 'publication.successful_publish',
      toolVersion: '1.0.0',
      arguments: { editionId: randomUUID() },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['publication.write']),
      idempotencyKey: `publish:${randomUUID()}`,
    });
    const inFlight = await service.propose({
      runId,
      toolId: 'publication.delayed_publish',
      toolVersion: '1.0.0',
      arguments: { editionId: randomUUID() },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['publication.write']),
      idempotencyKey: `publish:${randomUUID()}`,
    });
    expect(search.status).toBe('proposed');
    expect(publish.status).toBe('awaiting_approval');
    await service.decideApproval({
      toolCallId: inFlight.toolCallId,
      decision: 'approved',
      userId,
    });
    const delayedBefore = delayedExternalExecutions;
    const lateSettlement = service.execute(inFlight.toolCallId);
    await waitForToolStatus(inFlight.toolCallId, 'executing');
    expect(delayedExternalExecutions - delayedBefore).toBe(1);

    const runs = new DirectRunService({
      database: connection.db,
      publisher: {
        publish(event) {
          published.push(event);
          return Promise.resolve();
        },
      },
      runtimeFactory: {
        create() {
          throw new Error('Cancellation ledger test must not invoke the runtime');
        },
      },
      systemPrompt: 'You are AgentPress.',
    });
    await expect(runs.requestCancellation(runId)).resolves.toMatchObject({
      outcome: 'accepted',
      status: 'cancelling',
    });

    const rows = await connection.db
      .select({ id: toolCalls.id, status: toolCalls.status, settledAt: toolCalls.settledAt })
      .from(toolCalls)
      .where(eq(toolCalls.runId, runId));
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: search.toolCallId, status: 'cancelled', settledAt: expect.any(Date) as Date },
        { id: publish.toolCallId, status: 'cancelled', settledAt: expect.any(Date) as Date },
        {
          id: inFlight.toolCallId,
          status: 'outcome_unknown',
          settledAt: expect.any(Date) as Date,
        },
      ]),
    );
    finishDelayedPublish?.({ publicationId: randomUUID() });
    await expect(lateSettlement).resolves.toMatchObject({ status: 'outcome_unknown' });
    await expect(service.execute(search.toolCallId)).rejects.toMatchObject({
      code: 'invalid_tool_state',
    });
    await expect(
      service.decideApproval({
        toolCallId: publish.toolCallId,
        decision: 'approved',
        userId,
      }),
    ).rejects.toMatchObject({ code: 'invalid_tool_state' });
    await expect(
      service.propose({
        runId,
        toolId: 'workspace.search',
        toolVersion: '1.0.0',
        arguments: { query: 'too late' },
        requestedFromUserId: userId,
        allowedCapabilities: new Set(['workspace.read']),
      }),
    ).rejects.toMatchObject({ code: 'invalid_tool_state' });

    const liveEvents = published
      .slice(publishedFrom)
      .flatMap((event) => (event.durable && event.event.runId === runId ? [event.event] : []));
    expect(
      liveEvents
        .filter(({ eventType }) => eventType === 'tool.cancelled')
        .map(({ payload }) => payload),
    ).toEqual(
      expect.arrayContaining([
        { toolCallId: search.toolCallId, reason: 'run_cancelled', phase: 'before_dispatch' },
        { toolCallId: publish.toolCallId, reason: 'run_cancelled', phase: 'before_dispatch' },
      ]),
    );
    expect(
      liveEvents.find(
        ({ eventType, payload }) =>
          eventType === 'tool.outcome_unknown' && payload.toolCallId === inFlight.toolCallId,
      )?.payload,
    ).toMatchObject({
      reason: 'run_cancelled_after_dispatch',
      phase: 'after_dispatch',
      failure: {
        code: 'outcome_unknown',
        messageKey: 'tool.failure.outcome_unknown',
        retryable: false,
        outcomeReason: 'run_cancelled_after_dispatch',
      },
    });
    const projection = await new RunProjectionService(connection.db).get(runId);
    expect(projection?.parts).toEqual(projectRunParts(liveEvents));
    expect(projection?.pendingInteraction).toBeUndefined();
    expect(
      projection?.parts
        .filter(({ status }) => status === 'tool.cancelled')
        .map(({ outcome }) => outcome),
    ).toEqual(['cancelled', 'cancelled']);
    expect(
      projection?.parts.find(
        ({ status, payload }) =>
          status === 'tool.outcome_unknown' && payload.toolCallId === inFlight.toolCallId,
      ),
    ).toMatchObject({
      outcome: 'outcome_unknown',
      payload: {
        failure: { outcomeReason: 'run_cancelled_after_dispatch' },
      },
    });
  });

  it('serializes approval and cancellation without reviving the Tool Call', async () => {
    const runId = await createRunningRun();
    const proposal = await service.propose({
      runId,
      toolId: 'publication.successful_publish',
      toolVersion: '1.0.0',
      arguments: { editionId: randomUUID() },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['publication.write']),
      idempotencyKey: `publish:${randomUUID()}`,
    });
    const runs = new DirectRunService({
      database: connection.db,
      publisher: {
        publish(event) {
          published.push(event);
          return Promise.resolve();
        },
      },
      runtimeFactory: {
        create() {
          throw new Error('Cancellation race test must not invoke the runtime');
        },
      },
      systemPrompt: 'You are AgentPress.',
    });

    const [cancellation, approval] = await Promise.allSettled([
      runs.requestCancellation(runId),
      service.decideApproval({
        toolCallId: proposal.toolCallId,
        decision: 'approved',
        userId,
      }),
    ]);
    expect(cancellation).toMatchObject({
      status: 'fulfilled',
      value: { outcome: 'accepted', status: 'cancelling' },
    });
    if (approval.status === 'rejected') {
      expect(approval.reason).toMatchObject({ code: 'invalid_tool_state' });
    } else {
      expect(approval.value).toMatchObject({ status: 'approved' });
    }
    await expect(
      connection.db
        .select({ status: toolCalls.status })
        .from(toolCalls)
        .where(eq(toolCalls.id, proposal.toolCallId)),
    ).resolves.toEqual([{ status: 'cancelled' }]);
    const projection = await new RunProjectionService(connection.db).get(runId);
    expect(projection?.pendingInteraction).toBeUndefined();
    expect(projection).toMatchObject({
      status: 'cancelling',
      parts: expect.arrayContaining([
        expect.objectContaining({
          status: 'tool.cancelled',
          outcome: 'cancelled',
        }),
      ]) as unknown,
    });
  });

  it('narrows runtime tools to the intersection of pinned Skill permissions', async () => {
    const runId = await createRunningRun();
    const markdown =
      '---\nid: publish-only\nversion: 1.0.0\ndescription: Restrict tools\nallowedTools:\n  - publication.publish\n---\nOnly use the declared tool.';
    const skillRevisionId = randomUUID();
    await connection.db.insert(skillRevisions).values({
      id: skillRevisionId,
      workspaceId,
      skillId: 'publish-only',
      version: '1.0.0',
      content: markdown,
      contentHash: createHash('sha256').update(markdown).digest('hex'),
      allowedTools: ['publication.publish'],
    });
    await connection.db.insert(runSkillBindings).values({
      runId,
      skillRevisionId,
      contentHash: createHash('sha256').update(markdown).digest('hex'),
      allowedTools: ['publication.publish'],
    });
    const tools = await new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: service,
    }).createForRun(runId, ['publication.write']);
    expect(tools.map(({ label }) => label)).toEqual(['publication.publish']);
  });

  it('fails closed when a pinned Skill binding hash drifts from its revision', async () => {
    const runId = await createRunningRun();
    const markdown =
      '---\nid: drifted-skill\nversion: 1.0.0\ndescription: Detect drift\nallowedTools:\n  - workspace.search\n---\nUse the pinned revision.';
    const contentHash = createHash('sha256').update(markdown).digest('hex');
    const skillRevisionId = randomUUID();
    await connection.db.insert(skillRevisions).values({
      id: skillRevisionId,
      workspaceId,
      skillId: 'drifted-skill',
      version: '1.0.0',
      content: markdown,
      contentHash,
      allowedTools: ['workspace.search'],
    });
    await connection.db.insert(runSkillBindings).values({
      runId,
      skillRevisionId,
      contentHash: 'tampered-binding-hash',
      allowedTools: ['workspace.search'],
    });

    await expect(
      new PersistentToolBridge({
        database: connection.db,
        registry,
        toolCalls: service,
      }).createForRun(runId, ['workspace.read']),
    ).rejects.toMatchObject({
      name: 'ToolCallApplicationError',
      code: 'unauthorized_tool',
    });
  });

  it('uses the capability catalog to expose only the semantically relevant tool set', async () => {
    const runId = await createRunningRun();
    const tools = await new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: service,
      capabilityLimit: 1,
    }).createForRun(runId, ['workspace.read']);
    expect(tools.map(({ label }) => label)).toEqual(['workspace.search']);
  });

  it('rejects approval if exact persisted arguments no longer match', async () => {
    const runId = await createRunningRun();
    const proposal = await proposePublish(runId);
    await connection.db
      .update(toolCalls)
      .set({ argumentsHash: 'tampered' })
      .where(eq(toolCalls.id, proposal.toolCallId));

    await expect(
      service.decideApproval({
        toolCallId: proposal.toolCallId,
        decision: 'approved',
        userId,
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
  });

  it('commits expiry before returning an approval error', async () => {
    const runId = await createRunningRun();
    const proposal = await proposePublish(runId);
    await connection.db
      .update(approvals)
      .set({ expiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(approvals.toolCallId, proposal.toolCallId));

    await expect(
      service.decideApproval({
        toolCallId: proposal.toolCallId,
        decision: 'approved',
        userId,
      }),
    ).rejects.toMatchObject({ code: 'approval_expired' });
    const rows = await connection.db
      .select({ decision: approvals.decision })
      .from(approvals)
      .where(eq(approvals.toolCallId, proposal.toolCallId));
    expect(rows[0]?.decision).toBe('expired');
  });

  it('never retries an external Tool Call with Unknown Outcome', async () => {
    const runId = await createRunningRun();
    const proposal = await proposePublish(runId);
    await service.decideApproval({
      toolCallId: proposal.toolCallId,
      decision: 'approved',
      userId,
    });
    await expect(service.execute(proposal.toolCallId)).resolves.toMatchObject({
      status: 'outcome_unknown',
    });
    await expect(service.execute(proposal.toolCallId)).rejects.toMatchObject({
      code: 'invalid_tool_state',
    });
    expect(externalExecutions).toBe(1);
    const rows = await connection.db
      .select({ status: toolCalls.status })
      .from(toolCalls)
      .where(eq(toolCalls.id, proposal.toolCallId));
    expect(rows[0]?.status).toBe('outcome_unknown');
  });

  it('fences the same Specialist side effect across attempts without merging a second operation', async () => {
    const runId = await createRunningRun();
    const taskId = await createRunningTask(runId, 1);
    const bridge = new PersistentToolBridge({
      database: connection.db,
      registry,
      toolCalls: service,
    });
    const editionId = randomUUID();
    const firstPublish = (await bridge.createForRun(runId, ['publication.write'], taskId, 1)).find(
      (tool) => tool.label === 'publication.delayed_publish',
    );
    const before = delayedExternalExecutions;
    const firstExecution = firstPublish?.execute(
      { editionId },
      { runId, providerToolCallId: 'attempt-1-operation-1' },
    );
    const firstApproval = await waitForTaskApproval(taskId, 1);
    await service.decideApproval({
      toolCallId: firstApproval.toolCallId,
      decision: 'approved',
      userId,
    });
    await waitForToolStatus(firstApproval.toolCallId, 'executing');
    expect(delayedExternalExecutions - before).toBe(1);

    await connection.db
      .update(agentTasks)
      .set({ attempt: 2, status: 'running' })
      .where(eq(agentTasks.id, taskId));
    const recoveredPublish = (
      await bridge.createForRun(runId, ['publication.write'], taskId, 2)
    ).find((tool) => tool.label === 'publication.delayed_publish');
    await expect(
      recoveredPublish?.execute(
        { editionId },
        { runId, providerToolCallId: 'attempt-2-operation-1' },
      ),
    ).rejects.toMatchObject({ code: 'tool_replay_blocked' });
    expect(delayedExternalExecutions - before).toBe(1);

    finishDelayedPublish?.({ publicationId: randomUUID() });
    await expect(firstExecution).rejects.toMatchObject({ code: 'tool_replay_blocked' });

    await expect(
      recoveredPublish?.execute(
        { editionId },
        { runId, providerToolCallId: 'attempt-2-operation-2' },
      ),
    ).rejects.toMatchObject({ code: 'tool_replay_blocked' });
    expect(delayedExternalExecutions - before).toBe(1);
    const approvalRows = await connection.db
      .select({ id: approvals.id })
      .from(approvals)
      .innerJoin(toolCalls, eq(toolCalls.id, approvals.toolCallId))
      .where(eq(toolCalls.taskId, taskId));
    expect(approvalRows).toHaveLength(1);
  });

  it('keeps two successful same-argument Specialist operations distinct', async () => {
    const runId = await createRunningRun();
    const taskId = await createRunningTask(runId, 1);
    const publish = (
      await new PersistentToolBridge({
        database: connection.db,
        registry,
        toolCalls: service,
      }).createForRun(runId, ['publication.write'], taskId, 1)
    ).find((tool) => tool.label === 'publication.successful_publish');
    const editionId = randomUUID();
    const before = successfulExternalExecutions;
    for (const providerToolCallId of ['successful-operation-1', 'successful-operation-2']) {
      const execution = publish?.execute({ editionId }, { runId, providerToolCallId });
      const approval = await waitForTaskApproval(
        taskId,
        providerToolCallId === 'successful-operation-1' ? 1 : 2,
      );
      await service.decideApproval({
        toolCallId: approval.toolCallId,
        decision: 'approved',
        userId,
      });
      expectPublicationOutput(await execution);
    }
    await connection.db
      .update(agentTasks)
      .set({ attempt: 2, status: 'running' })
      .where(eq(agentTasks.id, taskId));
    const recoveredPublish = (
      await new PersistentToolBridge({
        database: connection.db,
        registry,
        toolCalls: service,
      }).createForRun(runId, ['publication.write'], taskId, 2)
    ).find((tool) => tool.label === 'publication.successful_publish');
    const recoveredExecution = recoveredPublish?.execute(
      { editionId },
      { runId, providerToolCallId: 'successful-operation-3' },
    );
    const recoveredApproval = await waitForTaskApproval(taskId, 3);
    await service.decideApproval({
      toolCallId: recoveredApproval.toolCallId,
      decision: 'approved',
      userId,
    });
    expectPublicationOutput(await recoveredExecution);
    expect(successfulExternalExecutions - before).toBe(3);
    const calls = await connection.db
      .select({
        ordinal: toolCalls.taskOperationOrdinal,
        operationKey: toolCalls.taskOperationKey,
        status: toolCalls.status,
      })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, taskId))
      .orderBy(toolCalls.taskOperationOrdinal);
    expect(calls.map(({ ordinal, status }) => ({ ordinal, status }))).toEqual([
      { ordinal: 1, status: 'succeeded' },
      { ordinal: 2, status: 'succeeded' },
      { ordinal: 3, status: 'succeeded' },
    ]);
    expect(new Set(calls.map(({ operationKey }) => operationKey)).size).toBe(3);
  });

  it('settles an executing external write as Unknown Outcome during recovery', async () => {
    const runId = await createRunningRun();
    const toolCallId = randomUUID();
    await connection.db.insert(toolCalls).values({
      id: toolCallId,
      runId,
      toolId: 'publication.publish',
      toolVersion: '1.0.0',
      arguments: { editionId: randomUUID() },
      argumentsHash: 'already-dispatched',
      risk: 'external_write',
      sideEffect: 'Publish the selected immutable edition',
      idempotencyKey: `publish:${randomUUID()}`,
      status: 'executing',
    });
    const runs = new DirectRunService({
      database: connection.db,
      publisher: {
        publish(event) {
          published.push(event);
          return Promise.resolve();
        },
      },
      runtimeFactory: {
        create() {
          throw new Error('Recovery test must not invoke the runtime');
        },
      },
      systemPrompt: 'You are AgentPress.',
    });

    await expect(runs.prepareRecovery(runId)).resolves.toBe(true);
    const rows = await connection.db
      .select({ status: toolCalls.status })
      .from(toolCalls)
      .where(eq(toolCalls.id, toolCallId));
    expect(rows[0]?.status).toBe('outcome_unknown');
  });

  it('requeues an interrupted read-only call for exactly-once recovery', async () => {
    const runId = await createRunningRun();
    const toolCallId = randomUUID();
    await connection.db.insert(toolCalls).values({
      id: toolCallId,
      runId,
      toolId: 'workspace.search',
      toolVersion: '1.0.0',
      arguments: { query: 'recoverable' },
      argumentsHash: hashToolArguments({ query: 'recoverable' }),
      risk: 'read_only',
      sideEffect: 'No side effect',
      status: 'executing',
    });
    const runs = new DirectRunService({
      database: connection.db,
      publisher: {
        publish(event) {
          published.push(event);
          return Promise.resolve();
        },
      },
      runtimeFactory: {
        create() {
          throw new Error('Recovery test must not invoke the runtime');
        },
      },
      systemPrompt: 'You are AgentPress.',
    });

    await expect(runs.prepareRecovery(runId)).resolves.toBe(true);
    const rows = await connection.db
      .select({ status: toolCalls.status })
      .from(toolCalls)
      .where(eq(toolCalls.id, toolCallId));
    expect(rows[0]?.status).toBe('approved');
    expect(
      published.some((event) => event.durable && event.event.eventType === 'tool.recovery_ready'),
    ).toBe(true);
    const saved = await connection.db
      .select({ state: checkpoints.state })
      .from(checkpoints)
      .where(eq(checkpoints.runId, runId));
    expect(saved.at(-1)?.state).toMatchObject({ replayReadyToolCalls: [toolCallId] });
    const events = await connection.db
      .select({ eventType: runEvents.eventType })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));
    expect(events.map(({ eventType }) => eventType)).toContain('tool.recovery_ready');
  });

  async function proposePublish(runId: string) {
    return service.propose({
      runId,
      toolId: 'publication.publish',
      toolVersion: '1.0.0',
      arguments: { editionId: randomUUID() },
      requestedFromUserId: userId,
      allowedCapabilities: new Set(['publication.write']),
      idempotencyKey: `publish:${randomUUID()}`,
    });
  }

  async function createRunningRun(): Promise<string> {
    const branchId = randomUUID();
    const messageId = randomUUID();
    const requestId = randomUUID();
    const runId = randomUUID();
    await connection.db.insert(conversationBranches).values({ id: branchId, conversationId });
    await connection.db.insert(conversationMessages).values({
      id: messageId,
      branchId,
      role: 'user',
      sequence: 1,
      content: [],
      stable: true,
    });
    await connection.db.insert(rootRequests).values({
      id: requestId,
      branchId,
      messageId,
      requestedByUserId: userId,
      idempotencyKey: randomUUID(),
    });
    await connection.db.insert(agentRuns).values({
      id: runId,
      workspaceId,
      branchId,
      rootRequestId: requestId,
      mode: 'direct',
      status: 'running',
    });
    return runId;
  }

  async function createRunningTask(runId: string, attempt: number): Promise<string> {
    const planId = randomUUID();
    const revisionId = randomUUID();
    const taskId = randomUUID();
    await connection.db.insert(executionPlans).values({ id: planId, runId });
    await connection.db.insert(planRevisions).values({
      id: revisionId,
      planId,
      revisionNumber: 1,
      reason: 'tool recovery integration',
      summary: 'Exercise Specialist side-effect fencing',
    });
    await connection.db.insert(agentTasks).values({
      id: taskId,
      runId,
      planRevisionId: revisionId,
      objective: 'Publish one immutable edition',
      criticality: 'required',
      owner: 'writer',
      acceptanceCriteria: ['The logical publication happens at most once'],
      outputSchema: { type: 'object' },
      toolPolicy: { capabilities: ['publication.write'] },
      budget: {},
      status: 'running',
      attempt,
      maxAttempts: 3,
    });
    return taskId;
  }

  async function waitForTaskApproval(
    taskId: string,
    expectedCount: number,
  ): Promise<{ readonly toolCallId: string }> {
    for (let poll = 0; poll < 100; poll += 1) {
      const rows = await connection.db
        .select({ toolCallId: approvals.toolCallId })
        .from(approvals)
        .innerJoin(toolCalls, eq(toolCalls.id, approvals.toolCallId))
        .where(eq(toolCalls.taskId, taskId))
        .orderBy(approvals.createdAt);
      const latest = rows.at(-1);
      if (rows.length >= expectedCount && latest) return latest;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for Specialist approval ${String(expectedCount)}`);
  }

  async function waitForToolStatus(toolCallId: string, expectedStatus: 'executing'): Promise<void> {
    for (let poll = 0; poll < 100; poll += 1) {
      const rows = await connection.db
        .select({ status: toolCalls.status })
        .from(toolCalls)
        .where(eq(toolCalls.id, toolCallId));
      if (rows[0]?.status === expectedStatus) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for Tool Call ${toolCallId} to become ${expectedStatus}`);
  }

  function expectPublicationOutput(value: unknown): void {
    const output =
      typeof value === 'object' && value !== null
        ? (value as Readonly<Record<string, unknown>>)
        : {};
    expect(typeof output.publicationId).toBe('string');
  }
});

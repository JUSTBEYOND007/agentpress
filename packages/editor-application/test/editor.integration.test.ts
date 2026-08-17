import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  hashBlock,
  hashDocument,
  type ArticleDocument,
  type EditorBlock,
} from '@agentpress/editor-patch';
import {
  appUsers,
  agentRuns,
  articles,
  articleRevisions,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  editProposals,
  mentionBindings,
  outboxMessages,
  rootRequests,
  toolCalls,
  workspaces,
} from '@agentpress/database';
import { ToolRegistry } from '@agentpress/tool-runtime';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AutosaveService,
  ProposalService,
  RedisWriterLease,
  registerArticleTools,
} from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeWithInfra = connectionString && redisUrl ? describe : describe.skip;
const paragraph = (blockId: string, text: string): EditorBlock => ({
  type: 'paragraph',
  attrs: { blockId },
  content: [{ type: 'text', text }],
});

describeWithInfra('editor persistence and recovery', () => {
  const connection = connectDatabase(connectionString ?? '');
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    article: randomUUID(),
    revision: randomUUID(),
    conversation: randomUUID(),
    branch: randomUUID(),
    message: randomUUID(),
    request: randomUUID(),
    run: randomUUID(),
  };
  const first = paragraph('block-a', 'Old');
  const second = paragraph('block-b', 'Keep');
  const document: ArticleDocument = { type: 'doc', content: [first, second] };
  beforeAll(async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    await redis.connect();
    await connection.db
      .insert(appUsers)
      .values({ id: ids.user, logtoSubject: `editor|${ids.user}`, displayName: 'Editor' });
    await connection.db.insert(workspaces).values({ id: ids.workspace, name: 'Editor' });
    await connection.db
      .insert(articles)
      .values({ id: ids.article, workspaceId: ids.workspace, title: 'Draft' });
    await connection.db.insert(articleRevisions).values({
      id: ids.revision,
      articleId: ids.article,
      revisionNumber: 1,
      schemaVersion: 1,
      document,
      documentHash: hashDocument(document),
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
      title: 'Article tools',
    });
    await connection.db
      .insert(conversationBranches)
      .values({ id: ids.branch, conversationId: ids.conversation });
    await connection.db.insert(conversationMessages).values({
      id: ids.message,
      branchId: ids.branch,
      role: 'user',
      sequence: 1,
      content: [{ type: 'text', text: '修改文章' }],
      stable: true,
    });
    await connection.db.insert(rootRequests).values({
      id: ids.request,
      branchId: ids.branch,
      messageId: ids.message,
      requestedByUserId: ids.user,
      idempotencyKey: randomUUID(),
    });
    await connection.db.insert(agentRuns).values({
      id: ids.run,
      workspaceId: ids.workspace,
      branchId: ids.branch,
      rootRequestId: ids.request,
      mode: 'direct',
      status: 'running',
    });
    await connection.db.insert(mentionBindings).values({
      id: randomUUID(),
      runId: ids.run,
      targetId: ids.article,
      targetKind: 'article',
      revision: ids.revision,
      contentHash: hashDocument(document),
      authorizedUserId: ids.user,
    });
  });
  afterAll(async () => {
    redis.disconnect();
    await connection.close();
  });

  it('fences writers and idempotently restores acknowledged ProseMirror steps', async () => {
    const leases = new RedisWriterLease(redis, 10_000);
    const leaseId = randomUUID();
    expect(await leases.acquire(ids.article, ids.user, leaseId)).toBe(true);
    expect(await leases.acquire(ids.article, ids.user, randomUUID())).toBe(false);
    const service = new AutosaveService(connection.db, leases);
    const batch = {
      updateId: randomUUID(),
      articleId: ids.article,
      userId: ids.user,
      writerLeaseId: leaseId,
      baseRevisionId: ids.revision,
      schemaVersion: 1,
      steps: [
        {
          stepType: 'replace',
          from: 1,
          to: 4,
          slice: { content: [{ type: 'text', text: 'New' }] },
        },
      ],
    };
    const firstAck = await service.save(batch);
    const duplicate = await service.save(batch);
    expect(firstAck).toMatchObject({ serverSequence: 1, duplicate: false });
    expect(duplicate).toMatchObject({ serverSequence: 1, duplicate: true });
    expect(await service.recover(ids.article, ids.user)).toMatchObject({
      documentHash: firstAck.documentHash,
      serverSequence: 1,
    });
    expect(await leases.renew(ids.article, ids.user, leaseId)).toBe(true);
    expect(await leases.release(ids.article, ids.user, leaseId)).toBe(true);
  });

  it('exposes current block hashes and creates a persisted proposal through Agent tools', async () => {
    const registry = new ToolRegistry();
    const proposals = new ProposalService(connection.db);
    registerArticleTools(registry, connection.db, proposals);
    const context = { runId: ids.run, toolCallId: randomUUID() };
    await connection.db.insert(toolCalls).values({
      id: context.toolCallId,
      runId: ids.run,
      toolId: 'article.propose_edits',
      toolVersion: '1.1.0',
      arguments: {},
      argumentsHash: 'test',
      risk: 'draft_write',
      sideEffect: 'test proposal',
      status: 'executing',
    });
    const current = (await registry.execute(
      registry.get('article.read_current', '1.0.0'),
      {},
      context,
    )) as Record<string, unknown>;
    expect(current).toMatchObject({
      articleId: ids.article,
      revisionId: ids.revision,
      blockHashes: { 'block-a': hashBlock(first), 'block-b': hashBlock(second) },
    });

    const created = (await registry.execute(
      registry.get('article.propose_edits', '1.1.0'),
      {
        operations: [
          {
            kind: 'replace',
            blockId: 'block-a',
            block: paragraph('block-a', 'Tool replacement'),
          },
        ],
      },
      context,
    )) as Record<string, unknown>;
    expect(created).toMatchObject({
      articleId: ids.article,
      baseRevisionId: ids.revision,
      diffs: [
        {
          operationId: `op-${context.toolCallId}-1`,
          before: first,
          after: paragraph('block-a', 'Tool replacement'),
        },
      ],
    });
    const rows = await connection.db
      .select()
      .from(editProposals)
      .where(eq(editProposals.id, String(created.proposalId)));
    expect(rows[0]).toMatchObject({ articleId: ids.article, runId: ids.run, status: 'pending' });
    const secondToolCallId = randomUUID();
    await connection.db.insert(toolCalls).values({
      id: secondToolCallId,
      runId: ids.run,
      toolId: 'article.propose_edits',
      toolVersion: '1.1.0',
      arguments: {},
      argumentsHash: 'test-2',
      risk: 'draft_write',
      sideEffect: 'test proposal 2',
      status: 'executing',
    });
    const appended = (await registry.execute(
      registry.get('article.propose_edits', '1.1.0'),
      {
        operations: [
          {
            kind: 'delete',
            blockId: 'block-b',
          },
        ],
      },
      { runId: ids.run, toolCallId: secondToolCallId },
    )) as Record<string, unknown>;
    expect(appended).toMatchObject({
      operations: [
        { operationId: `op-${context.toolCallId}-1`, expectedHash: hashBlock(first) },
        { operationId: `op-${secondToolCallId}-1`, expectedHash: hashBlock(second) },
      ],
    });
    const batchIds = (appended.batches as readonly { id: string; status: string }[]).filter(
      ({ status }) => status === 'active',
    );
    expect(batchIds).toHaveLength(2);
    await expect(
      proposals.revertBatch({
        proposalId: String(created.proposalId),
        batchId: batchIds[0]?.id ?? '',
        userId: ids.user,
      }),
    ).rejects.toThrow('latest');
    await proposals.revertBatch({
      proposalId: String(created.proposalId),
      batchId: batchIds[1]?.id ?? '',
      userId: ids.user,
    });
    await expect(
      proposals.decideOperation({
        proposalId: String(created.proposalId),
        operationId: `op-${context.toolCallId}-1`,
        userId: ids.user,
        decision: 'rejected',
      }),
    ).resolves.toMatchObject({ status: 'rejected' });

    const onlyBatchProposal = await proposals.create({
      articleId: ids.article,
      operations: [
        {
          operationId: 'undo-only-batch',
          kind: 'replace',
          blockId: 'block-a',
          expectedHash: hashBlock(first),
          block: paragraph('block-a', 'Temporary'),
        },
      ],
    });
    const onlyBatch = onlyBatchProposal.batches[0];
    expect(onlyBatch?.status).toBe('active');
    await expect(
      proposals.revertBatch({
        proposalId: onlyBatchProposal.proposalId,
        batchId: onlyBatch?.id ?? '',
        userId: ids.user,
      }),
    ).resolves.toMatchObject({ status: 'rejected', operations: [] });
    await expect(proposals.getPending(ids.article)).resolves.toBeUndefined();

    await connection.db
      .update(editProposals)
      .set({ status: 'pending', operations: [], diffs: [] })
      .where(eq(editProposals.id, onlyBatchProposal.proposalId));
    await expect(proposals.getPending(ids.article)).resolves.toBeUndefined();
    const [repaired] = await connection.db
      .select({ status: editProposals.status })
      .from(editProposals)
      .where(eq(editProposals.id, onlyBatchProposal.proposalId));
    expect(repaired?.status).toBe('rejected');
  });

  it('keeps proposal identity and concurrency anchors under host control', async () => {
    const registry = new ToolRegistry();
    const proposals = new ProposalService(connection.db);
    registerArticleTools(registry, connection.db, proposals);
    const definition = registry.get('article.propose_edits', '1.1.0');
    const toolCallId = randomUUID();
    const context = { runId: ids.run, toolCallId };
    await connection.db.insert(toolCalls).values({
      id: toolCallId,
      runId: ids.run,
      toolId: 'article.propose_edits',
      toolVersion: '1.1.0',
      arguments: {},
      argumentsHash: 'host-anchor-test',
      risk: 'draft_write',
      sideEffect: 'test host anchored proposal',
      status: 'executing',
    });

    await expect(
      registry.execute(
        definition,
        {
          operations: [
            {
              operationId: 'caller-owned',
              kind: 'delete',
              blockId: 'block-a',
              expectedHash: '0'.repeat(64),
            },
          ],
        },
        context,
      ),
    ).rejects.toThrow('invalid input');

    const created = (await registry.execute(
      definition,
      {
        operations: [
          {
            kind: 'replace',
            blockId: 'block-a',
            block: paragraph('block-a', 'First replacement'),
          },
          { kind: 'delete', blockId: 'block-b' },
        ],
      },
      context,
    )) as {
      readonly proposalId: string;
      readonly operations: readonly Record<string, unknown>[];
      readonly batches: readonly { readonly id: string }[];
    };
    expect(created.operations).toMatchObject([
      {
        operationId: `op-${toolCallId}-1`,
        expectedHash: hashBlock(first),
      },
      {
        operationId: `op-${toolCallId}-2`,
        expectedHash: hashBlock(second),
      },
    ]);
    expect(new Set(created.operations.map(({ operationId }) => operationId)).size).toBe(2);
    await expect(
      proposals.revertBatch({
        proposalId: created.proposalId,
        batchId: created.batches[0]?.id ?? '',
        userId: ids.user,
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
  });

  it('normalizes repairable Agent article edit operations before creating a proposal', async () => {
    const registry = new ToolRegistry();
    const proposals = new ProposalService(connection.db);
    registerArticleTools(registry, connection.db, proposals);
    const definition = registry.get('article.propose_edits', '1.1.0');
    const operationSchema = (
      definition.inputSchema as unknown as {
        readonly properties: {
          readonly operations: { readonly items: { readonly anyOf: readonly unknown[] } };
        };
      }
    ).properties.operations.items;
    expect(definition.constrainedSampling).toBe(false);
    expect(operationSchema.anyOf).toHaveLength(5);
    const insertSchema = operationSchema.anyOf.find(
      (candidate) =>
        (candidate as { readonly properties?: { readonly kind?: { readonly const?: unknown } } })
          .properties?.kind?.const === 'insert',
    ) as {
      readonly properties: {
        readonly block: {
          readonly properties: { readonly attrs: { readonly additionalProperties: boolean } };
        };
      };
    };
    expect(insertSchema.properties.block.properties.attrs.additionalProperties).toBe(true);
    const toolCallId = randomUUID();
    const context = { runId: ids.run, toolCallId };
    await connection.db.insert(toolCalls).values({
      id: toolCallId,
      runId: ids.run,
      toolId: 'article.propose_edits',
      toolVersion: '1.1.0',
      arguments: {},
      argumentsHash: 'repairable-agent-shape',
      risk: 'draft_write',
      sideEffect: 'test repaired proposal',
      status: 'executing',
    });

    const created = (await registry.execute(
      definition,
      {
        operations: [
          {
            kind: 'insert',
            block: {
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: 'Agent generated heading' }],
            },
          },
          {
            kind: 'insert',
            block: {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Agent generated continuation' }],
            },
          },
        ],
        reviewMode: 'granular',
      },
      context,
    )) as {
      readonly proposalId: string;
      readonly operations: readonly {
        readonly operationId: string;
        readonly kind: string;
        readonly afterBlockId?: string | null;
        readonly block?: { readonly attrs?: { readonly blockId?: string } };
      }[];
      readonly diffs: readonly { readonly kind: string; readonly blockId: string }[];
    };

    expect(created.operations).toMatchObject([
      {
        operationId: `op-${toolCallId}-1`,
        kind: 'insert',
        afterBlockId: 'block-b',
        block: { attrs: { level: 2, blockId: `agent-${toolCallId}-1` } },
      },
      {
        operationId: `op-${toolCallId}-2`,
        kind: 'insert',
        afterBlockId: `agent-${toolCallId}-1`,
        block: { attrs: { blockId: `agent-${toolCallId}-2` } },
      },
    ]);
    expect(created.diffs).toMatchObject([
      {
        kind: 'insert',
        blockId: `agent-${toolCallId}-1`,
      },
      {
        kind: 'insert',
        blockId: `agent-${toolCallId}-2`,
      },
    ]);
    await expect(
      proposals.decide({
        proposalId: created.proposalId,
        userId: ids.user,
        decisions: {
          [`op-${toolCallId}-1`]: 'rejected',
          [`op-${toolCallId}-2`]: 'rejected',
        },
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
  });

  it('rejects ambiguous or order-invalid model edit operations before proposal persistence', async () => {
    const registry = new ToolRegistry();
    const proposals = new ProposalService(connection.db);
    registerArticleTools(registry, connection.db, proposals);
    const definition = registry.get('article.propose_edits', '1.1.0');
    const execute = async (operations: readonly unknown[]) => {
      const toolCallId = randomUUID();
      await connection.db.insert(toolCalls).values({
        id: toolCallId,
        runId: ids.run,
        toolId: 'article.propose_edits',
        toolVersion: '1.1.0',
        arguments: {},
        argumentsHash: `invalid-model-shape-${toolCallId}`,
        risk: 'draft_write',
        sideEffect: 'test invalid normalized proposal',
        status: 'executing',
      });
      return registry.execute(definition, { operations }, { runId: ids.run, toolCallId });
    };

    await expect(execute([{ kind: 'rewrite', blockId: 'block-a' }])).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      execute([{ kind: 'insert', block: { attrs: {}, content: [] } }]),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      execute([
        { kind: 'delete', blockId: 'block-a' },
        {
          kind: 'replace',
          blockId: 'block-a',
          block: { type: 'paragraph', content: [{ type: 'text', text: 'Too late' }] },
        },
      ]),
    ).rejects.toThrow('block block-a does not exist');
    await expect(
      execute([
        {
          kind: 'insert',
          block: {
            type: 'paragraph',
            attrs: { blockId: 'block-a' },
            content: [{ type: 'text', text: 'Duplicate identity' }],
          },
        },
      ]),
    ).rejects.toThrow('insert block block-a already exists');

    const pending = await connection.db
      .select({ id: editProposals.id })
      .from(editProposals)
      .where(and(eq(editProposals.runId, ids.run), eq(editProposals.status, 'pending')));
    expect(pending).toHaveLength(0);
  });

  it('applies accepted proposal operations into an immutable revision', async () => {
    const service = new ProposalService(connection.db);
    const proposal = await service.create({
      articleId: ids.article,
      operations: [
        {
          operationId: 'replace-a',
          kind: 'replace',
          blockId: 'block-a',
          expectedHash: hashBlock(first),
          block: paragraph('block-a', 'New'),
        },
        {
          operationId: 'delete-b',
          kind: 'delete',
          blockId: 'block-b',
          expectedHash: hashBlock(second),
        },
      ],
    });
    expect(proposal).toMatchObject({
      articleId: ids.article,
      baseRevisionId: ids.revision,
      diffs: [
        { operationId: 'replace-a', before: first, after: paragraph('block-a', 'New') },
        { operationId: 'delete-b', before: second },
      ],
    });
    const result = await service.decide({
      proposalId: proposal.proposalId,
      userId: ids.user,
      decisions: { 'replace-a': 'accepted', 'delete-b': 'rejected' },
    });
    expect(result).toMatchObject({
      status: 'partially_accepted',
      appliedOperationIds: ['replace-a'],
    });
    const revisions = await connection.db
      .select()
      .from(articleRevisions)
      .where(eq(articleRevisions.articleId, ids.article));
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.source).toBe('proposal');
  });

  it('persists each operation decision and settles only after every operation is decided', async () => {
    const service = new ProposalService(connection.db);
    const currentFirst = paragraph('block-a', 'New');
    await expect(
      service.create({
        articleId: ids.article,
        baseRevisionId: ids.revision,
        operations: [
          {
            operationId: 'stale-replace',
            kind: 'replace',
            blockId: 'block-a',
            expectedHash: hashBlock(first),
            block: paragraph('block-a', 'Stale'),
          },
        ],
      }),
    ).rejects.toThrow('authorized');
    const proposal = await service.create({
      articleId: ids.article,
      operations: [
        {
          operationId: 'reject-a',
          kind: 'replace',
          blockId: 'block-a',
          expectedHash: hashBlock(currentFirst),
          block: paragraph('block-a', 'Ignored'),
        },
        {
          operationId: 'reject-b',
          kind: 'delete',
          blockId: 'block-b',
          expectedHash: hashBlock(second),
        },
      ],
    });
    await expect(
      service.decideOperation({
        proposalId: proposal.proposalId,
        operationId: 'reject-a',
        userId: ids.user,
        decision: 'rejected',
      }),
    ).resolves.toMatchObject({ status: 'pending', decisions: { 'reject-a': 'rejected' } });
    await expect(service.getPending(ids.article)).resolves.toMatchObject({
      proposalId: proposal.proposalId,
      decisions: { 'reject-a': 'rejected' },
    });
    await expect(
      service.decideOperation({
        proposalId: proposal.proposalId,
        operationId: 'reject-a',
        userId: ids.user,
        decision: 'rejected',
      }),
    ).resolves.toMatchObject({ status: 'pending' });
    await expect(
      service.decideOperation({
        proposalId: proposal.proposalId,
        operationId: 'reject-a',
        userId: ids.user,
        decision: 'accepted',
      }),
    ).rejects.toThrow('opposite decision');
    await expect(
      service.decide({
        proposalId: proposal.proposalId,
        userId: ids.user,
        decisions: { 'reject-b': 'rejected', 'reject-a': 'accepted' },
      }),
    ).rejects.toThrow('opposite decision');
    await expect(service.getPending(ids.article)).resolves.toMatchObject({
      proposalId: proposal.proposalId,
      decisions: { 'reject-a': 'rejected' },
    });
    await expect(
      service.decideOperation({
        proposalId: proposal.proposalId,
        operationId: 'reject-b',
        userId: ids.user,
        decision: 'rejected',
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
  });

  it('commits proposal expiry before returning a stale settlement error', async () => {
    const articleId = randomUUID();
    const baseRevisionId = randomUUID();
    const currentRevisionId = randomUUID();
    const currentDocument: ArticleDocument = {
      type: 'doc',
      content: [paragraph('block-a', 'Manual revision'), second],
    };
    await connection.db.insert(articles).values({
      id: articleId,
      workspaceId: ids.workspace,
      title: 'Stale settlement',
    });
    await connection.db.insert(articleRevisions).values({
      id: baseRevisionId,
      articleId,
      revisionNumber: 1,
      schemaVersion: 1,
      document,
      documentHash: hashDocument(document),
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId: baseRevisionId })
      .where(eq(articles.id, articleId));
    const service = new ProposalService(connection.db);
    const proposal = await service.create({
      articleId,
      operations: [
        {
          operationId: 'stale-settlement',
          kind: 'replace',
          blockId: 'block-a',
          expectedHash: hashBlock(first),
          block: paragraph('block-a', 'Agent draft'),
        },
      ],
    });
    await connection.db.insert(articleRevisions).values({
      id: currentRevisionId,
      articleId,
      revisionNumber: 2,
      schemaVersion: 1,
      document: currentDocument,
      documentHash: hashDocument(currentDocument),
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId })
      .where(eq(articles.id, articleId));

    await expect(
      service.decide({
        proposalId: proposal.proposalId,
        userId: ids.user,
        decisions: { 'stale-settlement': 'accepted' },
      }),
    ).rejects.toThrow('stale');
    const [expired] = await connection.db
      .select({ status: editProposals.status })
      .from(editProposals)
      .where(eq(editProposals.id, proposal.proposalId));
    expect(expired?.status).toBe('expired');
    await expect(service.getPending(articleId)).resolves.toBeUndefined();
  });

  it('expires a stale working draft before rejecting a new append', async () => {
    const articleId = randomUUID();
    const baseRevisionId = randomUUID();
    const currentRevisionId = randomUUID();
    const currentFirst = paragraph('block-a', 'Manual revision');
    const currentDocument: ArticleDocument = { type: 'doc', content: [currentFirst, second] };
    await connection.db.insert(articles).values({
      id: articleId,
      workspaceId: ids.workspace,
      title: 'Stale append',
    });
    await connection.db.insert(articleRevisions).values({
      id: baseRevisionId,
      articleId,
      revisionNumber: 1,
      schemaVersion: 1,
      document,
      documentHash: hashDocument(document),
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId: baseRevisionId })
      .where(eq(articles.id, articleId));
    const service = new ProposalService(connection.db);
    const proposal = await service.create({
      articleId,
      operations: [
        {
          operationId: 'initial-draft',
          kind: 'replace',
          blockId: 'block-a',
          expectedHash: hashBlock(first),
          block: paragraph('block-a', 'Agent draft'),
        },
      ],
    });
    await connection.db.insert(articleRevisions).values({
      id: currentRevisionId,
      articleId,
      revisionNumber: 2,
      schemaVersion: 1,
      document: currentDocument,
      documentHash: hashDocument(currentDocument),
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId })
      .where(eq(articles.id, articleId));

    await expect(
      service.create({
        articleId,
        operations: [
          {
            operationId: 'new-draft',
            kind: 'replace',
            blockId: 'block-a',
            expectedHash: hashBlock(currentFirst),
            block: paragraph('block-a', 'New agent draft'),
          },
        ],
      }),
    ).rejects.toThrow('working draft');
    const [expired] = await connection.db
      .select({ status: editProposals.status })
      .from(editProposals)
      .where(eq(editProposals.id, proposal.proposalId));
    expect(expired?.status).toBe('expired');
  });

  it('settles a complete article write as one document decision', async () => {
    const service = new ProposalService(connection.db);
    const currentFirst = paragraph('block-a', 'New');
    const proposal = await service.create({
      articleId: ids.article,
      reviewMode: 'document',
      operations: [
        {
          operationId: 'document-replace-a',
          kind: 'replace',
          blockId: 'block-a',
          expectedHash: hashBlock(currentFirst),
          block: paragraph('block-a', 'Document first'),
        },
        {
          operationId: 'document-replace-b',
          kind: 'replace',
          blockId: 'block-b',
          expectedHash: hashBlock(second),
          block: paragraph('block-b', 'Document second'),
        },
      ],
    });
    await expect(
      service.decide({
        proposalId: proposal.proposalId,
        userId: ids.user,
        decisions: { 'document-replace-a': 'accepted' },
      }),
    ).resolves.toMatchObject({
      status: 'accepted',
      appliedOperationIds: ['document-replace-a', 'document-replace-b'],
      reviewMode: 'document',
    });
  });

  it('normalizes a serialized document into valid top-level blocks', async () => {
    const service = new ProposalService(connection.db);
    const proposal = await service.create({
      articleId: ids.article,
      reviewMode: 'document',
      operations: [
        {
          operationId: 'serialized-document',
          kind: 'insert',
          afterBlockId: null,
          block: {
            type: 'doc',
            attrs: { blockId: 'draft-root' },
            content: [
              paragraph('generated-title', 'Generated title'),
              paragraph('generated-body', 'Generated body'),
            ],
          },
        },
      ],
    });

    expect(
      proposal.operations.map((operation) => [
        operation.kind,
        'block' in operation ? operation.block.type : undefined,
      ]),
    ).toEqual([
      ['delete', undefined],
      ['delete', undefined],
      ['insert', 'paragraph'],
      ['insert', 'paragraph'],
    ]);
    await expect(
      service.decide({
        proposalId: proposal.proposalId,
        userId: ids.user,
        decisions: { 'serialized-document:delete:0': 'accepted' },
      }),
    ).resolves.toMatchObject({ status: 'accepted' });

    const [article] = await connection.db
      .select({ currentRevisionId: articles.currentRevisionId })
      .from(articles)
      .where(eq(articles.id, ids.article));
    const [revision] = await connection.db
      .select({ document: articleRevisions.document })
      .from(articleRevisions)
      .where(eq(articleRevisions.id, article?.currentRevisionId ?? ''));
    expect(
      (revision?.document as { content: readonly { attrs: { blockId: string } }[] }).content.map(
        ({ attrs }) => attrs.blockId,
      ),
    ).toEqual(['generated-title', 'generated-body']);
  });

  it('atomically promotes an acknowledged draft and schedules its index update', async () => {
    const articleId = randomUUID();
    const revisionId = randomUUID();
    const leaseId = randomUUID();
    await connection.db.insert(articles).values({
      id: articleId,
      workspaceId: ids.workspace,
      title: 'Autosave promotion',
    });
    await connection.db.insert(articleRevisions).values({
      id: revisionId,
      articleId,
      revisionNumber: 1,
      schemaVersion: 1,
      document,
      documentHash: hashDocument(document),
      source: 'manual',
      createdByUserId: ids.user,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId: revisionId })
      .where(eq(articles.id, articleId));
    const leases = new RedisWriterLease(redis, 10_000);
    expect(await leases.acquire(articleId, ids.user, leaseId)).toBe(true);
    const service = new AutosaveService(connection.db, leases);
    const acknowledgement = await service.save({
      updateId: randomUUID(),
      articleId,
      userId: ids.user,
      writerLeaseId: leaseId,
      baseRevisionId: revisionId,
      schemaVersion: 1,
      steps: [
        {
          stepType: 'replace',
          from: 1,
          to: 4,
          slice: { content: [{ type: 'text', text: 'Committed' }] },
        },
      ],
    });
    const committed = await service.commit({
      articleId,
      userId: ids.user,
      writerLeaseId: leaseId,
      expectedServerSequence: acknowledgement.serverSequence,
    });
    expect(committed).toMatchObject({
      articleId,
      revisionNumber: 2,
      documentHash: acknowledgement.documentHash,
      committedServerSequence: acknowledgement.serverSequence,
    });
    expect(await service.recover(articleId, ids.user)).toBeUndefined();
    const [article] = await connection.db.select().from(articles).where(eq(articles.id, articleId));
    expect(article).toMatchObject({ currentRevisionId: committed.revisionId, version: 2 });
    const indexed = await connection.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, committed.revisionId));
    expect(indexed[0]?.topic).toBe('knowledge.article.index.commands');
  });
});

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
  rootRequests,
  workspaces,
} from '@agentpress/database';
import { ToolRegistry } from '@agentpress/tool-runtime';
import { eq } from 'drizzle-orm';
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
    registerArticleTools(registry, connection.db, new ProposalService(connection.db));
    const context = { runId: ids.run, toolCallId: randomUUID() };
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
      registry.get('article.propose_edits', '1.0.0'),
      {
        operations: [
          {
            operationId: 'tool-replace-a',
            kind: 'replace',
            blockId: 'block-a',
            expectedHash: hashBlock(first),
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
          operationId: 'tool-replace-a',
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
});

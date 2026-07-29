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
  articles,
  articleRevisions,
  connectDatabase,
  editProposals,
  workspaces,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutosaveService, ProposalService, RedisWriterLease } from '../src/index.js';

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
    proposal: randomUUID(),
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

  it('applies accepted proposal operations into an immutable revision', async () => {
    await connection.db.insert(editProposals).values({
      id: ids.proposal,
      articleId: ids.article,
      baseRevisionId: ids.revision,
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
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await new ProposalService(connection.db).decide({
      proposalId: ids.proposal,
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

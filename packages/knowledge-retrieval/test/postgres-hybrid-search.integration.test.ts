import { createHash, randomUUID } from 'node:crypto';

import {
  connectDatabase,
  appUsers,
  articleRevisions,
  articles,
  knowledgeChunks,
  knowledgeDocuments,
  workspaces,
} from '@agentpress/database';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { ArticleKnowledgeIndexer, PostgresHybridSearch } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('PostgreSQL hybrid retrieval', () => {
  it('indexes an immutable article revision into deterministic chunks with real provider vectors', async () => {
    const connection = connectDatabase(connectionString ?? '');
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const articleId = randomUUID();
    const revisionId = randomUUID();
    const document = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'block-1' },
          content: [{ type: 'text', text: 'Kafka durable recovery' }],
        },
      ],
    };
    await connection.db.insert(appUsers).values({
      id: userId,
      logtoSubject: `indexer|${userId}`,
      displayName: 'Indexer',
    });
    await connection.db.insert(workspaces).values({ id: workspaceId, name: 'Indexer' });
    await connection.db.insert(articles).values({ id: articleId, workspaceId, title: 'Kafka' });
    await connection.db.insert(articleRevisions).values({
      id: revisionId,
      articleId,
      revisionNumber: 1,
      schemaVersion: 1,
      document,
      documentHash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
      source: 'manual',
      createdByUserId: userId,
    });
    await connection.db
      .update(articles)
      .set({ currentRevisionId: revisionId })
      .where(eq(articles.id, articleId));
    const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
    const indexer = new ArticleKnowledgeIndexer(connection.db, {
      embed: (texts) => Promise.resolve(texts.map(() => vector)),
    });
    await expect(indexer.indexRevision(revisionId)).resolves.toMatchObject({ duplicate: false });
    await expect(indexer.indexRevision(revisionId)).resolves.toMatchObject({ duplicate: true });
    const documents = await connection.db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceUri, `article:${articleId}`));
    expect(documents).toHaveLength(1);
    const chunks = await connection.db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, documents[0]?.id ?? ''));
    expect(chunks[0]).toMatchObject({ content: 'Kafka durable recovery', ordinal: 0 });
    await connection.close();
  });

  it('filters workspace and ACL before fusion and emits revision-bound Evidence', async () => {
    const connection = connectDatabase(connectionString ?? '');
    const workspaceId = randomUUID();
    const hiddenWorkspaceId = randomUUID();
    await connection.db.insert(workspaces).values([
      { id: workspaceId, name: 'RAG' },
      { id: hiddenWorkspaceId, name: 'Hidden' },
    ]);
    const documents = [
      {
        id: randomUUID(),
        workspaceId,
        sourceUri: 'workspace://allowed',
        title: 'Allowed',
        revisionHash: 'sha256:allowed',
        acl: ['user:allowed'],
      },
      {
        id: randomUUID(),
        workspaceId,
        sourceUri: 'workspace://denied',
        title: 'Denied',
        revisionHash: 'sha256:denied',
        acl: ['user:denied'],
      },
      {
        id: randomUUID(),
        workspaceId: hiddenWorkspaceId,
        sourceUri: 'workspace://other',
        title: 'Other',
        revisionHash: 'sha256:other',
        acl: ['user:allowed'],
      },
    ];
    await connection.db.insert(knowledgeDocuments).values(documents);
    const embedding = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
    await connection.db.insert(knowledgeChunks).values(
      documents.map((document, index) => ({
        id: randomUUID(),
        documentId: document.id,
        ordinal: 0,
        content: `Kafka recovery ${String(index)}`,
        contentHash: `sha256:chunk-${String(index)}`,
        embedding,
        tokenCount: 3,
      })),
    );
    const search = new PostgresHybridSearch(connection.db);
    const result = await search.search({
      workspaceId,
      principals: ['user:allowed'],
      query: 'Kafka recovery',
      embedding,
      rerank: (_query, candidates) =>
        Promise.resolve(new Map(candidates.map((candidate) => [candidate.chunkId, 0.9]))),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      workspaceId,
      source: 'workspace://allowed',
      revisionHash: 'sha256:allowed',
      acl: ['user:allowed'],
      rerankScore: 0.9,
    });
    await connection.close();
  });
});

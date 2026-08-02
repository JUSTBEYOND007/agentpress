import { createHash, randomUUID } from 'node:crypto';

import {
  articleRevisions,
  articles,
  type AgentPressDatabase,
  knowledgeChunks,
  knowledgeDocuments,
} from '@agentpress/database';
import { and, eq } from 'drizzle-orm';

export type EmbeddingProvider = {
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;
};

export class ArticleKnowledgeIndexer {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly embeddings: EmbeddingProvider,
    private readonly createId: () => string = randomUUID,
  ) {}

  public async indexRevision(revisionId: string, signal?: AbortSignal) {
    const rows = await this.database
      .select({
        articleId: articles.id,
        workspaceId: articles.workspaceId,
        title: articles.title,
        revisionId: articleRevisions.id,
        revisionHash: articleRevisions.documentHash,
        document: articleRevisions.document,
      })
      .from(articleRevisions)
      .innerJoin(articles, eq(articles.id, articleRevisions.articleId))
      .where(eq(articleRevisions.id, revisionId))
      .limit(1);
    const revision = rows[0];
    if (!revision) throw new Error(`Article revision ${revisionId} does not exist`);
    const chunks = chunkDocument(revision.document);
    const vectors = await this.embeddings.embed(chunks, signal);
    return this.database.transaction(async (transaction) => {
      const existing = await transaction
        .select({ id: knowledgeDocuments.id })
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.workspaceId, revision.workspaceId),
            eq(knowledgeDocuments.sourceUri, `article:${revision.articleId}`),
            eq(knowledgeDocuments.revisionHash, revision.revisionHash),
          ),
        )
        .limit(1);
      if (existing[0]) return { documentId: existing[0].id, duplicate: true };
      const documentId = this.createId();
      await transaction.insert(knowledgeDocuments).values({
        id: documentId,
        workspaceId: revision.workspaceId,
        sourceUri: `article:${revision.articleId}`,
        title: revision.title,
        revisionHash: revision.revisionHash,
        acl: ['workspace:members'],
      });
      await transaction.insert(knowledgeChunks).values(
        chunks.map((content, ordinal) => ({
          id: this.createId(),
          documentId,
          ordinal,
          content,
          contentHash: createHash('sha256').update(content).digest('hex'),
          embedding: vectors[ordinal] ?? [],
          tokenCount: Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4)),
        })),
      );
      return { documentId, duplicate: false };
    });
  }
}

function chunkDocument(document: Readonly<Record<string, unknown>>): readonly string[] {
  const content = Array.isArray(document.content) ? document.content : [];
  const blocks = content.flatMap((block) => {
    if (!isRecord(block)) return [];
    const text = extractText(block).trim();
    return text ? [text] : [];
  });
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (current && Buffer.byteLength(`${current}\n${block}`, 'utf8') > 2_400) {
      chunks.push(current);
      current = block;
    } else current = current ? `${current}\n${block}` : block;
  }
  if (current) chunks.push(current);
  if (chunks.length === 0) chunks.push('[empty article]');
  return chunks;
}

function extractText(value: unknown): string {
  if (Array.isArray(value)) return value.map(extractText).join(' ');
  if (!isRecord(value)) return '';
  return [typeof value.text === 'string' ? value.text : '', extractText(value.content)].join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

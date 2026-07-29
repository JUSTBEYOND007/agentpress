import type { AgentPressDatabase } from '@agentpress/database';
import { sql } from 'drizzle-orm';

import type { Evidence } from './hybrid-search.js';

export type PostgresSearchRequest = {
  readonly workspaceId: string;
  readonly principals: readonly string[];
  readonly query: string;
  readonly embedding: readonly number[];
  readonly limit?: number;
  readonly rerank?: (
    query: string,
    candidates: readonly RetrievalCandidate[],
  ) => Promise<ReadonlyMap<string, number>>;
};

export type RetrievalCandidate = Omit<Evidence, 'retrievalScore' | 'rerankScore'> & {
  readonly lexicalRank: number;
  readonly semanticDistance: number;
};

type RetrievalRow = {
  readonly chunk_id: string;
  readonly workspace_id: string;
  readonly source_uri: string;
  readonly revision_hash: string;
  readonly content: string;
  readonly content_hash: string;
  readonly acl: readonly string[];
  readonly lexical_rank: number | string;
  readonly semantic_distance: number | string;
  readonly reciprocal_rank_score: number | string;
};

export class PostgresHybridSearch {
  public constructor(private readonly database: AgentPressDatabase) {}

  public async search(request: PostgresSearchRequest): Promise<readonly Evidence[]> {
    const limit = request.limit ?? 8;
    if (request.principals.length === 0) return [];
    if (request.embedding.length !== 1536)
      throw new RangeError('Embedding must contain 1536 dimensions');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new RangeError('Search limit must be between 1 and 50');
    const candidateLimit = Math.min(limit * 4, 200);
    const embedding = `[${request.embedding.join(',')}]`;
    const principals = sql.join(
      request.principals.map((principal) => sql`${principal}`),
      sql`, `,
    );
    const result = await this.database.execute(sql<RetrievalRow>`
      with permitted as materialized (
        select c.id, c.content, c.content_hash, c.embedding,
               d.workspace_id, d.source_uri, d.revision_hash, d.acl
          from knowledge_chunks c
          join knowledge_documents d on d.id = c.document_id
         where d.workspace_id = ${request.workspaceId}::uuid
           and d.acl ?| array[${principals}]::text[]
      ), lexical as (
        select id, row_number() over (order by ts_rank_cd(to_tsvector('simple', content), websearch_to_tsquery('simple', ${request.query})) desc, id) lexical_rank
          from permitted
         where to_tsvector('simple', content) @@ websearch_to_tsquery('simple', ${request.query})
         order by ts_rank_cd(to_tsvector('simple', content), websearch_to_tsquery('simple', ${request.query})) desc, id
         limit ${candidateLimit}
      ), semantic as (
        select id, row_number() over (order by embedding <=> ${embedding}::vector, id) semantic_rank,
               embedding <=> ${embedding}::vector semantic_distance
          from permitted order by embedding <=> ${embedding}::vector, id limit ${candidateLimit}
      ), fused as (
        select coalesce(l.id, s.id) id,
               coalesce(1.0 / (60 + l.lexical_rank), 0) + coalesce(1.0 / (60 + s.semantic_rank), 0) reciprocal_rank_score,
               coalesce(l.lexical_rank, 2147483647) lexical_rank,
               coalesce(s.semantic_distance, 2) semantic_distance
          from lexical l full join semantic s on s.id = l.id
      )
      select p.id chunk_id, p.workspace_id, p.source_uri, p.revision_hash, p.content, p.content_hash, p.acl,
             f.lexical_rank, f.semantic_distance, f.reciprocal_rank_score
        from fused f join permitted p on p.id = f.id
       order by f.reciprocal_rank_score desc, p.id limit ${candidateLimit}
    `);
    const rows = result.rows as unknown as readonly RetrievalRow[];
    const candidates = rows.map((row) => toCandidate(row));
    const reranks = request.rerank
      ? await request.rerank(request.query, candidates)
      : new Map<string, number>();
    return candidates
      .map((candidate, index) => ({
        candidate,
        retrievalScore: Number(rows[index]?.reciprocal_rank_score ?? 0),
        rerankScore: reranks.get(candidate.chunkId) ?? 0,
      }))
      .sort(
        (a, b) =>
          b.rerankScore - a.rerankScore ||
          b.retrievalScore - a.retrievalScore ||
          a.candidate.chunkId.localeCompare(b.candidate.chunkId),
      )
      .slice(0, limit)
      .map(({ candidate, retrievalScore, rerankScore }) => ({
        ...candidate,
        retrievalScore,
        rerankScore,
      }));
  }
}

function toCandidate(row: RetrievalRow): RetrievalCandidate {
  return {
    evidenceId: `workspace:${row.chunk_id}:${row.content_hash}`,
    workspaceId: row.workspace_id,
    source: row.source_uri,
    chunkId: row.chunk_id,
    revisionHash: row.revision_hash,
    text: row.content,
    acl: row.acl,
    lexicalRank: Number(row.lexical_rank),
    semanticDistance: Number(row.semantic_distance),
  };
}

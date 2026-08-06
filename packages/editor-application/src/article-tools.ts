import {
  articleRevisions,
  articles,
  type AgentPressDatabase,
  agentRuns,
  conversationBranches,
  conversations,
  mentionBindings,
} from '@agentpress/database';
import type { ToolRegistry } from '@agentpress/tool-runtime';
import {
  hashBlock,
  StaleEditError,
  type ArticleDocument,
  type EditOperation,
} from '@agentpress/editor-patch';
import { Type, type Static } from '@sinclair/typebox';
import { and, eq, sql } from 'drizzle-orm';

import { ProposalService } from './proposal-service.js';

const block = Type.Object(
  {
    type: Type.String({ minLength: 1, maxLength: 80 }),
    attrs: Type.Intersect([
      Type.Object({ blockId: Type.String({ minLength: 1, maxLength: 160 }) }),
      Type.Record(Type.String(), Type.Unknown()),
    ]),
    content: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 20_000 })),
  },
  { additionalProperties: false },
);
const anchored = {
  blockId: Type.String({ minLength: 1, maxLength: 160 }),
} as const;
const operations = Type.Array(
  Type.Union([
    Type.Object(
      {
        kind: Type.Literal('insert'),
        afterBlockId: Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
        block,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...anchored, kind: Type.Literal('replace'), block },
      { additionalProperties: false },
    ),
    Type.Object({ ...anchored, kind: Type.Literal('delete') }, { additionalProperties: false }),
    Type.Object(
      {
        ...anchored,
        kind: Type.Literal('move'),
        afterBlockId: Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...anchored,
        kind: Type.Literal('update_attrs'),
        attrs: Type.Record(Type.String(), Type.Unknown()),
      },
      { additionalProperties: false },
    ),
  ]),
  { minItems: 1, maxItems: 200 },
);
type ProposedOperation = Static<typeof operations>[number];
const reviewMode = Type.Optional(Type.Union([Type.Literal('granular'), Type.Literal('document')]));

export function registerArticleTools(
  registry: ToolRegistry,
  database: AgentPressDatabase,
  proposals: ProposalService,
): void {
  registry.register({
    toolId: 'article.read_current',
    version: '1.0.0',
    owner: 'agentpress.editor',
    description:
      'Read the current article revision with stable block IDs and hashes before proposing edits',
    capabilities: ['article.read'],
    inputSchema: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Any(),
    risk: 'read_only',
    sideEffect: 'Reads the current revision bound to this Agent Run',
    idempotency: 'none',
    timeoutMs: 5_000,
    estimateCost: () => ({}),
    execute: async (_input, context) => {
      const current = await resolveRunArticle(database, context.runId);
      return {
        articleId: current.articleId,
        revisionId: current.revisionId,
        document: current.document,
        blockHashes: Object.fromEntries(
          (current.document as ArticleDocument).content.map((item) => [
            item.attrs.blockId,
            hashBlock(item),
          ]),
        ),
      };
    },
  });
  registry.register({
    toolId: 'article.propose_edits',
    version: '1.1.0',
    owner: 'agentpress.editor',
    description: 'Create a reviewable article edit proposal; never writes the article directly',
    guidance: [
      {
        id: 'stable-anchors',
        text: 'Use stable block IDs from article.read_current. The host binds operation IDs and SHA-256 anchors.',
      },
      {
        id: 'review-mode',
        text: 'Use reviewMode=document for a complete rewrite and granular for local edits.',
      },
    ],
    capabilities: ['article.propose'],
    inputSchema: Type.Object({ operations, reviewMode }, { additionalProperties: false }),
    outputSchema: Type.Any(),
    risk: 'draft_write',
    sideEffect:
      'Creates an expiring edit proposal; document mode presents the batch as one whole-article change, while internal block operations remain auditable; the article changes only after user decisions',
    idempotency: 'provider_key',
    timeoutMs: 10_000,
    estimateCost: () => ({}),
    execute: async (
      { operations: proposedOperations, reviewMode: proposedReviewMode },
      context,
    ) => {
      const current = await resolveRunArticle(database, context.runId);
      const anchoredOperations = anchorProposedOperations(
        current.document as ArticleDocument,
        proposedOperations,
        context.toolCallId,
      );
      return proposals
        .create({
          articleId: current.articleId,
          runId: context.runId,
          sourceToolCallId: context.toolCallId,
          baseRevisionId: current.revisionId,
          operations: anchoredOperations,
          reviewMode: proposedReviewMode ?? 'granular',
        })
        .then((proposal) => ({ kind: 'article_edit_proposal' as const, ...proposal }));
    },
  });
}

function anchorProposedOperations(
  document: ArticleDocument,
  proposedOperations: readonly ProposedOperation[],
  toolCallId: string,
): readonly EditOperation[] {
  const blocks = new Map(document.content.map((item) => [item.attrs.blockId, item]));
  return proposedOperations.map((operation, index) => {
    const operationId = `op-${toolCallId}-${String(index + 1)}`;
    if (operation.kind === 'insert') return { ...operation, operationId };
    const current = blocks.get(operation.blockId);
    if (!current) {
      throw new StaleEditError(operationId, `Block ${operation.blockId} no longer exists`);
    }
    const expectedHash = hashBlock(current);
    if (operation.kind === 'replace') {
      return { ...operation, operationId, expectedHash };
    }
    if (operation.kind === 'move') {
      return { ...operation, operationId, expectedHash };
    }
    if (operation.kind === 'update_attrs') {
      return { ...operation, operationId, expectedHash };
    }
    return { ...operation, operationId, expectedHash };
  });
}

async function resolveRunArticle(database: AgentPressDatabase, runId: string) {
  const rows = await database
    .select({
      articleId: articles.id,
      revisionId: articleRevisions.id,
      document: articleRevisions.document,
    })
    .from(agentRuns)
    .innerJoin(conversationBranches, eq(conversationBranches.id, agentRuns.branchId))
    .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
    .innerJoin(articles, eq(articles.id, conversations.articleId))
    .innerJoin(
      mentionBindings,
      and(
        eq(mentionBindings.runId, agentRuns.id),
        eq(mentionBindings.targetId, articles.id),
        eq(mentionBindings.targetKind, 'article'),
      ),
    )
    .innerJoin(
      articleRevisions,
      and(
        sql`${articleRevisions.id}::text = ${mentionBindings.revision}`,
        eq(articleRevisions.articleId, articles.id),
      ),
    )
    .where(eq(agentRuns.id, runId))
    .limit(1);
  const current = rows[0];
  if (!current) throw new Error('Agent Run is not bound to an editable article');
  return current;
}

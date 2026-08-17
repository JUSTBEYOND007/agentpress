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
    attrs: Type.Object(
      { blockId: Type.String({ minLength: 1, maxLength: 160 }) },
      { additionalProperties: true },
    ),
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
const modelFacingOperation = Type.Object(
  {
    kind: Type.String({ minLength: 1, maxLength: 40 }),
    blockId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    afterBlockId: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
    ),
    block: Type.Optional(Type.Unknown()),
    attrs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: true },
);
const proposeEditsInput = Type.Object(
  {
    operations: Type.Array(modelFacingOperation, { minItems: 1, maxItems: 200 }),
    reviewMode,
  },
  { additionalProperties: false },
);

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
    inputSchema: proposeEditsInput,
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
      const normalizedOperations = normalizeProposedOperations(
        current.document as ArticleDocument,
        proposedOperations,
        context.toolCallId,
      );
      const anchoredOperations = anchorProposedOperations(
        current.document as ArticleDocument,
        normalizedOperations,
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

function normalizeProposedOperations(
  document: ArticleDocument,
  proposedOperations: readonly unknown[],
  toolCallId: string,
): readonly ProposedOperation[] {
  const blockIds = new Set(document.content.map((item) => item.attrs.blockId));
  const fallbackAfterBlockId = document.content.at(-1)?.attrs.blockId ?? null;
  const generatedBlockIds = new Set<string>();
  return proposedOperations.map((operation, index) => {
    if (!isRecord(operation)) throw invalidOperation(index, 'operation must be an object');
    rejectCallerOwnedAnchors(operation, index);
    const kind = operation.kind;
    if (kind === 'insert') {
      const blockValue = normalizeBlock(operation.block, index, {
        defaultBlockId: uniqueGeneratedBlockId(toolCallId, index, blockIds, generatedBlockIds),
      });
      const afterBlockId =
        operation.afterBlockId === undefined ? fallbackAfterBlockId : operation.afterBlockId;
      if (afterBlockId !== null && typeof afterBlockId !== 'string') {
        throw invalidOperation(index, 'insert.afterBlockId must be a string, null, or omitted');
      }
      if (typeof afterBlockId === 'string' && !blockIds.has(afterBlockId)) {
        throw invalidOperation(index, `insert anchor ${afterBlockId} does not exist`);
      }
      blockIds.add(blockValue.attrs.blockId);
      return { kind: 'insert', afterBlockId, block: blockValue };
    }
    if (kind === 'replace') {
      const blockId = normalizeAnchoredBlockId(operation, index, blockIds);
      const blockValue = normalizeBlock(operation.block, index, { defaultBlockId: blockId });
      return {
        kind: 'replace',
        blockId,
        block: { ...blockValue, attrs: { ...blockValue.attrs, blockId } },
      };
    }
    if (kind === 'delete') {
      return { kind: 'delete', blockId: normalizeAnchoredBlockId(operation, index, blockIds) };
    }
    if (kind === 'move') {
      const blockId = normalizeAnchoredBlockId(operation, index, blockIds);
      const afterBlockId = operation.afterBlockId;
      if (afterBlockId !== null && typeof afterBlockId !== 'string') {
        throw invalidOperation(index, 'move.afterBlockId must be a string or null');
      }
      if (afterBlockId === blockId) throw invalidOperation(index, 'move cannot anchor after itself');
      if (typeof afterBlockId === 'string' && !blockIds.has(afterBlockId)) {
        throw invalidOperation(index, `move anchor ${afterBlockId} does not exist`);
      }
      return { kind: 'move', blockId, afterBlockId };
    }
    if (kind === 'update_attrs') {
      const attrs = operation.attrs;
      if (!isRecord(attrs)) throw invalidOperation(index, 'update_attrs.attrs must be an object');
      return {
        kind: 'update_attrs',
        blockId: normalizeAnchoredBlockId(operation, index, blockIds),
        attrs,
      };
    }
    throw invalidOperation(index, `unsupported operation kind ${String(kind)}`);
  });
}

function rejectCallerOwnedAnchors(
  operation: Readonly<Record<string, unknown>>,
  index: number,
): void {
  if ('operationId' in operation || 'expectedHash' in operation) {
    throw invalidOperation(index, 'invalid input: operationId and expectedHash are host-owned');
  }
}

function normalizeAnchoredBlockId(
  operation: Readonly<Record<string, unknown>>,
  index: number,
  blockIds: ReadonlySet<string>,
): string {
  const explicit = operation.blockId;
  if (typeof explicit === 'string' && explicit.length > 0) {
    if (!blockIds.has(explicit)) throw invalidOperation(index, `block ${explicit} does not exist`);
    return explicit;
  }
  const blockValue = isRecord(operation.block) ? operation.block : undefined;
  const attrs = blockValue && isRecord(blockValue.attrs) ? blockValue.attrs : undefined;
  const nested = attrs?.blockId;
  if (typeof nested === 'string' && blockIds.has(nested)) return nested;
  throw invalidOperation(index, 'anchored operation requires an existing blockId');
}

function normalizeBlock(
  value: unknown,
  index: number,
  options: { readonly defaultBlockId: string },
): Static<typeof block> {
  if (!isRecord(value)) throw invalidOperation(index, 'block must be an object');
  if (typeof value.type !== 'string' || value.type.length === 0) {
    throw invalidOperation(index, 'block.type must be a non-empty string');
  }
  const attrs = isRecord(value.attrs) ? value.attrs : {};
  const rawBlockId = attrs.blockId;
  const blockId =
    typeof rawBlockId === 'string' && rawBlockId.length > 0 ? rawBlockId : options.defaultBlockId;
  const content =
    value.content === undefined
      ? undefined
      : Array.isArray(value.content)
        ? value.content
        : (() => {
            throw invalidOperation(index, 'block.content must be an array when provided');
          })();
  return {
    type: value.type,
    attrs: { ...attrs, blockId },
    ...(content ? { content } : {}),
  };
}

function uniqueGeneratedBlockId(
  toolCallId: string,
  index: number,
  existing: ReadonlySet<string>,
  generated: Set<string>,
): string {
  const base = `agent-${toolCallId}-${String(index + 1)}`;
  let candidate = base;
  let suffix = 1;
  while (existing.has(candidate) || generated.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${String(suffix)}`;
  }
  generated.add(candidate);
  return candidate;
}

function invalidOperation(index: number, message: string): Error {
  return new Error(`invalid input at operations/${String(index)}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

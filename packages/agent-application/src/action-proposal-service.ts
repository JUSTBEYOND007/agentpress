import { randomUUID } from 'node:crypto';

import {
  actionProposals,
  agentRuns,
  appendRunEvent,
  articleRevisions,
  articles,
  conversationBranches,
  conversations,
  mentionBindings,
  type AgentPressDatabase,
  rootRequests,
} from '@agentpress/database';
import { hashBlock, type EditorBlock } from '@agentpress/editor-patch';
import type { RuntimeTool } from '@agentpress/agent-runtime';
import { Type } from '@sinclair/typebox';
import { and, eq, sql } from 'drizzle-orm';

import type { DurableRunEvent, RunEventPublisher } from './contracts.js';
import type { DirectRunService } from './direct-run-service.js';

export type CreateActionProposalInput = {
  readonly runId: string;
  readonly instruction: string;
  readonly summary: string;
  readonly selectedBlocks: readonly { readonly blockId: string; readonly contentHash: string }[];
};

export type ActionProposalSnapshot = {
  readonly id: string;
  readonly sourceRunId: string;
  readonly articleId: string;
  readonly baseRevisionId: string;
  readonly instruction: string;
  readonly summary: string;
  readonly selectedBlocks: readonly { readonly blockId: string; readonly contentHash: string }[];
  readonly grantedCapabilities: readonly string[];
  readonly status: string;
  readonly expiresAt: Date;
  readonly confirmedRunId?: string;
};

export class ActionProposalService {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly publisher: RunEventPublisher,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  public createRuntimeTool(runId: string): RuntimeTool {
    return {
      name: 'action_propose',
      label: 'Propose article action',
      description:
        'Create a user-confirmable action card for any requested change to the current article. Never plan or edit article content in a free-text turn.',
      parameters: Type.Object(
        {
          instruction: Type.String({ minLength: 1, maxLength: 20_000 }),
          summary: Type.String({ minLength: 1, maxLength: 240 }),
          selectedBlocks: Type.Array(
            Type.Object(
              {
                blockId: Type.String({ minLength: 1, maxLength: 160 }),
                contentHash: Type.String({ minLength: 1, maxLength: 160 }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 200 },
          ),
        },
        { additionalProperties: false },
      ),
      constrainedSampling: { type: 'json_schema', strict: 'require' },
      executionMode: 'sequential',
      terminateOnSuccess: true,
      execute: async (arguments_) => {
        const proposal = await this.create({
          runId,
          instruction: String(arguments_.instruction),
          summary: String(arguments_.summary),
          selectedBlocks: arguments_.selectedBlocks as readonly {
            readonly blockId: string;
            readonly contentHash: string;
          }[],
        });
        return { kind: 'article_edit_action_proposal', proposal };
      },
    };
  }

  public async create(input: CreateActionProposalInput): Promise<ActionProposalSnapshot> {
    const instruction = input.instruction.trim();
    const summary = input.summary.trim();
    if (!instruction || !summary)
      throw new Error('Action proposal instruction and summary are required');

    const persisted = await this.database.transaction(async (transaction) => {
      const existing = await transaction
        .select()
        .from(actionProposals)
        .where(eq(actionProposals.sourceRunId, input.runId))
        .limit(1);
      if (existing[0]) return { proposal: existing[0] };

      const rows = await transaction
        .select({
          articleId: conversations.articleId,
          baseRevisionId: mentionBindings.revision,
          document: articleRevisions.document,
          requestedByUserId: rootRequests.requestedByUserId,
          actionEnvelope: rootRequests.actionEnvelope,
        })
        .from(agentRuns)
        .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
        .innerJoin(conversationBranches, eq(conversationBranches.id, agentRuns.branchId))
        .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
        .innerJoin(
          mentionBindings,
          and(
            eq(mentionBindings.runId, agentRuns.id),
            eq(mentionBindings.targetId, conversations.articleId),
            eq(mentionBindings.targetKind, 'article'),
          ),
        )
        .innerJoin(
          articleRevisions,
          sql`${articleRevisions.id}::text = ${mentionBindings.revision}`,
        )
        .where(eq(agentRuns.id, input.runId))
        .limit(1);
      const source = rows[0];
      if (
        !source?.articleId ||
        !source.baseRevisionId ||
        !source.requestedByUserId ||
        source.actionEnvelope.source !== 'free_text'
      ) {
        throw new Error('Only a free-text run bound to a current article can propose an action');
      }
      validateSelectedBlocks(source.document, input.selectedBlocks);

      const now = this.now();
      const proposal = {
        id: this.createId(),
        sourceRunId: input.runId,
        articleId: source.articleId,
        baseRevisionId: source.baseRevisionId,
        requestedByUserId: source.requestedByUserId,
        instruction,
        summary,
        selectedBlocks: input.selectedBlocks,
        grantedCapabilities: ['article.read', 'article.propose'],
        status: 'pending',
        confirmedRunId: null,
        expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      };
      await transaction.insert(actionProposals).values(proposal);
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId: input.runId,
        eventType: 'action.proposed',
        payload: snapshot(proposal),
      });
      return { proposal, event: toDurableEvent(event) };
    });
    if (persisted.event) await this.publisher.publish({ durable: true, event: persisted.event });
    return snapshot(persisted.proposal);
  }

  public async get(id: string): Promise<ActionProposalSnapshot | undefined> {
    const rows = await this.database
      .select()
      .from(actionProposals)
      .where(eq(actionProposals.id, id))
      .limit(1);
    return rows[0] ? snapshot(rows[0]) : undefined;
  }

  public async getBySourceRun(runId: string): Promise<ActionProposalSnapshot | undefined> {
    const rows = await this.database
      .select()
      .from(actionProposals)
      .where(eq(actionProposals.sourceRunId, runId))
      .limit(1);
    return rows[0] ? snapshot(rows[0]) : undefined;
  }

  public async confirm(
    id: string,
    userId: string,
    runs: Pick<DirectRunService, 'createConfirmedAction'>,
  ): Promise<ActionProposalSnapshot> {
    const resolution = await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from ${actionProposals} where id = ${id} for update`);
      const rows = await transaction
        .select({
          proposal: actionProposals,
          conversationId: conversations.id,
          branchId: agentRuns.branchId,
          currentRevisionId: articles.currentRevisionId,
        })
        .from(actionProposals)
        .innerJoin(agentRuns, eq(agentRuns.id, actionProposals.sourceRunId))
        .innerJoin(conversationBranches, eq(conversationBranches.id, agentRuns.branchId))
        .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
        .innerJoin(articles, eq(articles.id, actionProposals.articleId))
        .where(and(eq(actionProposals.id, id), eq(actionProposals.requestedByUserId, userId)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error('Action proposal does not exist');
      if (row.proposal.status === 'confirmed') return { kind: 'ready' as const, source: row };
      if (row.proposal.status !== 'pending')
        throw new Error(`Action proposal is ${row.proposal.status}`);
      if (row.proposal.expiresAt <= this.now()) {
        const now = this.now();
        await transaction
          .update(actionProposals)
          .set({ status: 'expired', updatedAt: now })
          .where(eq(actionProposals.id, id));
        const event = await appendRunEvent(transaction, {
          id: this.createId(),
          runId: row.proposal.sourceRunId,
          eventType: 'action.expired',
          payload: { proposalId: row.proposal.id },
        });
        return { kind: 'expired' as const, event: toDurableEvent(event) };
      }
      if (row.currentRevisionId !== row.proposal.baseRevisionId) {
        throw new Error('Action proposal base revision is stale');
      }
      return { kind: 'ready' as const, source: row };
    });
    if (resolution.kind === 'expired') {
      await this.publisher.publish({ durable: true, event: resolution.event });
      throw new Error('Action proposal has expired');
    }
    const source = resolution.source;
    if (source.proposal.status === 'confirmed') return snapshot(source.proposal);

    const created = await runs.createConfirmedAction({
      conversationId: source.conversationId,
      branchId: source.branchId,
      userId,
      proposalId: source.proposal.id,
      instruction: source.proposal.instruction,
      articleId: source.proposal.articleId,
      baseRevisionId: source.proposal.baseRevisionId,
      selectedBlocks: source.proposal.selectedBlocks,
      grantedCapabilities: source.proposal.grantedCapabilities,
    });
    const persisted = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(actionProposals)
        .set({
          status: 'confirmed',
          confirmedRunId: created.runId,
          confirmedAt: this.now(),
          updatedAt: this.now(),
        })
        .where(and(eq(actionProposals.id, id), eq(actionProposals.status, 'pending')))
        .returning();
      const updated = rows[0];
      const proposal =
        updated ??
        (
          await transaction
            .select()
            .from(actionProposals)
            .where(eq(actionProposals.id, id))
            .limit(1)
        )[0];
      if (!proposal?.confirmedRunId) throw new Error('Action proposal confirmation did not settle');
      if (!updated) return { proposal };
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId: proposal.sourceRunId,
        eventType: 'action.confirmed',
        payload: { proposalId: proposal.id, confirmedRunId: proposal.confirmedRunId },
      });
      return { proposal, event: toDurableEvent(event) };
    });
    if (persisted.event) await this.publisher.publish({ durable: true, event: persisted.event });
    return snapshot(persisted.proposal);
  }

  public async reject(id: string, userId: string): Promise<ActionProposalSnapshot> {
    const persisted = await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from ${actionProposals} where id = ${id} for update`);
      const current = await transaction
        .select()
        .from(actionProposals)
        .where(and(eq(actionProposals.id, id), eq(actionProposals.requestedByUserId, userId)))
        .limit(1);
      const proposal = current[0];
      if (!proposal) throw new Error('Action proposal does not exist');
      if (proposal.status === 'rejected') return { proposal };
      if (proposal.status !== 'pending') throw new Error(`Action proposal is ${proposal.status}`);
      const rows = await transaction
        .update(actionProposals)
        .set({ status: 'rejected', updatedAt: this.now() })
        .where(and(eq(actionProposals.id, id), eq(actionProposals.status, 'pending')))
        .returning();
      const rejected = rows[0];
      if (!rejected) throw new Error('Action proposal rejection did not settle');
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId: rejected.sourceRunId,
        eventType: 'action.rejected',
        payload: { proposalId: rejected.id },
      });
      return { proposal: rejected, event: toDurableEvent(event) };
    });
    if (persisted.event) await this.publisher.publish({ durable: true, event: persisted.event });
    return snapshot(persisted.proposal);
  }
}

function validateSelectedBlocks(
  document: Readonly<Record<string, unknown>>,
  selectedBlocks: readonly { readonly blockId: string; readonly contentHash: string }[],
): void {
  const content: readonly unknown[] = Array.isArray(document.content) ? document.content : [];
  for (const selection of selectedBlocks) {
    const block = content.find((candidate) => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
        return false;
      const record = candidate as Readonly<Record<string, unknown>>;
      const attrs = record.attrs;
      return (
        typeof attrs === 'object' &&
        attrs !== null &&
        !Array.isArray(attrs) &&
        'blockId' in attrs &&
        attrs.blockId === selection.blockId
      );
    });
    if (!block || hashBlock(block as EditorBlock) !== selection.contentHash) {
      throw new Error(`Selected article block ${selection.blockId} is stale or missing`);
    }
  }
}

type ProposalRow = Pick<
  typeof actionProposals.$inferSelect,
  | 'id'
  | 'sourceRunId'
  | 'articleId'
  | 'baseRevisionId'
  | 'instruction'
  | 'summary'
  | 'selectedBlocks'
  | 'grantedCapabilities'
  | 'status'
  | 'expiresAt'
  | 'confirmedRunId'
>;

function snapshot(proposal: ProposalRow): ActionProposalSnapshot {
  return {
    id: proposal.id,
    sourceRunId: proposal.sourceRunId,
    articleId: proposal.articleId,
    baseRevisionId: proposal.baseRevisionId,
    instruction: proposal.instruction,
    summary: proposal.summary,
    selectedBlocks: proposal.selectedBlocks,
    grantedCapabilities: proposal.grantedCapabilities,
    status: proposal.status,
    expiresAt: proposal.expiresAt,
    ...(proposal.confirmedRunId ? { confirmedRunId: proposal.confirmedRunId } : {}),
  };
}

function toDurableEvent(event: {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}): DurableRunEvent {
  return { ...event };
}

import {
  type AgentPressDatabase,
  conversationBranches,
  conversationCompactions,
  conversationMessages,
  conversations,
  workspaceMembers,
} from '@agentpress/database';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';

import { AgentApplicationError } from './contracts.js';
import { decodeRuntimeMessage } from './runtime-message-codec.js';

export class ConversationBranchService {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly createId: () => string,
  ) {}

  public async listMessages(
    conversationId: string,
    branchId: string,
    userId: string,
  ): Promise<readonly { id: string; role: 'user' | 'assistant'; content: string }[]> {
    const rows = await this.database
      .select({
        id: conversationMessages.id,
        role: conversationMessages.role,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .innerJoin(conversationBranches, eq(conversationBranches.id, conversationMessages.branchId))
      .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, conversations.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversationBranches.id, branchId),
          eq(conversationMessages.stable, true),
          inArray(conversationMessages.role, ['user', 'assistant']),
        ),
      )
      .orderBy(asc(conversationMessages.sequence));
    return rows.flatMap((row) => {
      const message = decodeRuntimeMessage(row.content);
      return message ? [{ id: row.id, role: message.role, content: message.content }] : [];
    });
  }

  public async fork(conversationId: string, branchId: string, messageId: string, userId: string) {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          workspaceId: conversations.workspaceId,
          sequence: conversationMessages.sequence,
        })
        .from(conversationMessages)
        .innerJoin(conversationBranches, eq(conversationBranches.id, conversationMessages.branchId))
        .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, conversations.workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        )
        .where(
          and(
            eq(conversationMessages.id, messageId),
            eq(conversationMessages.branchId, branchId),
            eq(conversations.id, conversationId),
            eq(conversationMessages.stable, true),
          ),
        )
        .limit(1);
      const forkPoint = rows[0];
      if (!forkPoint) {
        throw new AgentApplicationError(
          'branch_not_found',
          'Fork message does not exist on an authorized conversation branch',
        );
      }
      const messages = await transaction
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.branchId, branchId),
            eq(conversationMessages.stable, true),
            lte(conversationMessages.sequence, forkPoint.sequence),
          ),
        )
        .orderBy(asc(conversationMessages.sequence));
      const newBranchId = this.createId();
      const copied = messages.map((message) => ({
        sourceId: message.id,
        id: this.createId(),
        message,
      }));
      await transaction.insert(conversationBranches).values({
        id: newBranchId,
        conversationId,
        parentBranchId: branchId,
        forkedFromMessageId: messageId,
      });
      if (copied.length > 0) {
        await transaction.insert(conversationMessages).values(
          copied.map(({ id, message }) => ({
            id,
            branchId: newBranchId,
            role: message.role,
            sequence: message.sequence,
            content: message.content,
            stable: true,
            createdAt: message.createdAt,
          })),
        );
      }
      const parentCompactions = await transaction
        .select()
        .from(conversationCompactions)
        .where(
          and(
            eq(conversationCompactions.branchId, branchId),
            eq(conversationCompactions.status, 'completed'),
            lte(conversationCompactions.firstKeptMessageSequence, forkPoint.sequence),
          ),
        )
        .orderBy(desc(conversationCompactions.version))
        .limit(1);
      const parentCompaction = parentCompactions[0];
      if (parentCompaction && parentCompaction.firstKeptMessageSequence !== null) {
        const sourceFrom = copied.find(
          ({ message }) => message.sequence === parentCompaction.sourceFromSequence,
        );
        const sourceThrough = copied.find(
          ({ message }) => message.sequence === parentCompaction.sourceThroughSequence,
        );
        const firstKept = copied.find(
          ({ message }) => message.sequence === parentCompaction.firstKeptMessageSequence,
        );
        if (sourceFrom && sourceThrough && firstKept) {
          await transaction.insert(conversationCompactions).values({
            id: this.createId(),
            branchId: newBranchId,
            version: 1,
            status: 'completed',
            reason: 'branch_fork',
            sourceFromMessageId: sourceFrom.id,
            sourceFromSequence: parentCompaction.sourceFromSequence,
            sourceThroughMessageId: sourceThrough.id,
            sourceThroughSequence: parentCompaction.sourceThroughSequence,
            firstKeptMessageId: firstKept.id,
            firstKeptMessageSequence: parentCompaction.firstKeptMessageSequence,
            summary: parentCompaction.summary,
            shortSummary: parentCompaction.shortSummary,
            tokensBefore: parentCompaction.tokensBefore,
            tokenCount: parentCompaction.tokenCount,
            preserveData: parentCompaction.preserveData,
            model: parentCompaction.model,
            promptVersion: parentCompaction.promptVersion,
            reserveTokens: parentCompaction.reserveTokens,
            reserveProvenance: parentCompaction.reserveProvenance,
          });
        }
      }
      return {
        branchId: newBranchId,
        parentBranchId: branchId,
        forkedFromMessageId: messageId,
        forkedMessageId: copied.find(({ sourceId }) => sourceId === messageId)?.id,
      };
    });
  }
}

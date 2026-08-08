import type { RuntimeMessage } from '@agentpress/agent-runtime';
import { loadSkill } from '@agentpress/agent-context';
import type { ActionEnvelopeV1 } from '@agentpress/contracts';
import {
  agentRuns,
  appendRunEvent,
  conversationBranches,
  conversationMessages,
  conversations,
  type DatabaseTransaction,
  enqueueOutboxMessage,
  rootRequests,
  skillRevisions,
  type AgentPressDatabase,
  workspaceMembers,
} from '@agentpress/database';
import { and, desc, eq, max, sql } from 'drizzle-orm';

import {
  AGENT_RUN_COMMAND_TOPIC,
  AgentApplicationError,
  type CreateDirectRunInput,
  type CreateDirectRunResult,
  type RunEventPublisher,
  type SelectedSkillInput,
  type SkillPreselectionCandidate,
  type SkillPreselector,
} from './contracts.js';
import { RunContextService } from './run-context-service.js';
import { SkillSelectionError } from './skill-preselection.js';
import { toDurableEvent } from './run-projection-service.js';
import { decodeRuntimeMessage, encodeRuntimeMessage } from './runtime-message-codec.js';

type DirectRunCreationServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly publisher: RunEventPublisher;
  readonly contexts: RunContextService;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly dispatchCommands: boolean;
  readonly skillPreselector?: SkillPreselector;
};

export class DirectRunCreationService {
  public constructor(private readonly options: DirectRunCreationServiceOptions) {}

  public create(input: CreateDirectRunInput): Promise<CreateDirectRunResult> {
    return this.createWithEnvelope(input, {
      version: 1,
      source: 'free_text',
      grantedCapabilities: [],
    });
  }

  public createConfirmedAction(input: {
    readonly conversationId: string;
    readonly branchId: string;
    readonly userId: string;
    readonly proposalId: string;
    readonly instruction: string;
    readonly articleId: string;
    readonly baseRevisionId: string;
    readonly selectedBlocks: readonly { readonly blockId: string; readonly contentHash: string }[];
    readonly grantedCapabilities: readonly string[];
  }): Promise<CreateDirectRunResult> {
    const envelope: ActionEnvelopeV1 = {
      version: 1,
      source: 'button',
      requestedIntent: 'article_edit',
      actionProposalId: input.proposalId,
      payload: {
        instruction: input.instruction,
        articleId: input.articleId,
        baseRevisionId: input.baseRevisionId,
        selectedBlocks: [...input.selectedBlocks],
      },
      grantedCapabilities: [...input.grantedCapabilities],
    };
    return this.createWithEnvelope(
      {
        conversationId: input.conversationId,
        branchId: input.branchId,
        userId: input.userId,
        prompt: input.instruction,
        idempotencyKey: `action:${input.proposalId}`,
        contextBindings:
          input.selectedBlocks.length > 0
            ? [
                {
                  type: 'article_selection',
                  articleId: input.articleId,
                  revisionId: input.baseRevisionId,
                  blocks: input.selectedBlocks,
                },
              ]
            : [
                {
                  type: 'article_revision',
                  articleId: input.articleId,
                  revisionId: input.baseRevisionId,
                },
              ],
      },
      envelope,
    );
  }

  private async createWithEnvelope(
    input: CreateDirectRunInput,
    actionEnvelope: ActionEnvelopeV1,
  ): Promise<CreateDirectRunResult> {
    const prompt = input.prompt.trim();
    if (prompt.length === 0 || prompt.length > 100_000) {
      throw new AgentApplicationError(
        'invalid_prompt',
        'Prompt must contain between 1 and 100000 characters',
      );
    }

    const result = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${input.branchId}:${input.idempotencyKey}`}))`,
      );

      const existing = await transaction
        .select({
          runId: agentRuns.id,
          rootRequestId: rootRequests.id,
          messageId: rootRequests.messageId,
          status: agentRuns.status,
          mode: agentRuns.mode,
        })
        .from(rootRequests)
        .innerJoin(agentRuns, eq(agentRuns.rootRequestId, rootRequests.id))
        .where(
          and(
            eq(rootRequests.branchId, input.branchId),
            eq(rootRequests.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      const duplicate = existing[0];
      if (duplicate) {
        return {
          result: {
            runId: duplicate.runId,
            rootRequestId: duplicate.rootRequestId,
            messageId: duplicate.messageId,
            status: duplicate.status,
            mode: duplicate.mode,
            created: false,
          },
        };
      }

      const branchRows = await transaction
        .select({
          branchId: conversationBranches.id,
          conversationId: conversations.id,
          workspaceId: conversations.workspaceId,
          articleId: conversations.articleId,
        })
        .from(conversationBranches)
        .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
        .where(eq(conversationBranches.id, input.branchId))
        .limit(1);
      const branch = branchRows[0];
      if (!branch) {
        throw new AgentApplicationError('branch_not_found', 'Conversation branch does not exist');
      }
      if (branch.conversationId !== input.conversationId) {
        throw new AgentApplicationError(
          'conversation_not_found',
          'Conversation does not own the requested branch',
        );
      }
      const membership = await transaction
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, branch.workspaceId),
            eq(workspaceMembers.userId, input.userId),
          ),
        )
        .limit(1);
      if (!membership[0]) {
        throw new AgentApplicationError(
          'unauthorized_user',
          'User is not a member of the conversation workspace',
        );
      }

      const explicitSkills = collectSkillSelections(input);
      const candidates = this.options.skillPreselector
        ? await loadSkillPreselectionCandidates(transaction, branch.workspaceId)
        : [];
      let modelSkills: readonly SelectedSkillInput[] = [];
      let modelSelectionFailure: SkillSelectionError | undefined;
      if (this.options.skillPreselector) {
        try {
          modelSkills = validateModelSkillSelections(
            candidates,
            await this.options.skillPreselector.select({
              prompt,
              explicitSkills,
              candidates,
              maxSelections: 8,
            }),
          );
        } catch (error) {
          if (!(error instanceof SkillSelectionError)) throw error;
          modelSelectionFailure = error;
        }
      }
      const selectedSkills = mergeSkillSelections(explicitSkills, modelSkills);

      await transaction.execute(
        sql`select id from ${conversationBranches} where id = ${input.branchId} for update`,
      );
      const sequenceRows = await transaction
        .select({ sequence: max(conversationMessages.sequence) })
        .from(conversationMessages)
        .where(eq(conversationMessages.branchId, input.branchId));
      const messageSequence = (sequenceRows[0]?.sequence ?? 0) + 1;
      const existingMessage = input.existingMessageId
        ? await transaction
            .select({
              id: conversationMessages.id,
              content: conversationMessages.content,
              sequence: conversationMessages.sequence,
            })
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.id, input.existingMessageId),
                eq(conversationMessages.branchId, input.branchId),
                eq(conversationMessages.role, 'user'),
                eq(conversationMessages.stable, true),
              ),
            )
            .limit(1)
        : [];
      const existingRoot = existingMessage[0];
      if (input.existingMessageId) {
        const decoded = existingRoot ? decodeRuntimeMessage(existingRoot.content) : undefined;
        if (decoded?.role !== 'user' || decoded.content !== prompt) {
          throw new AgentApplicationError(
            'invalid_context',
            'The existing root message is missing or does not match this Run',
          );
        }
      }
      const messageId = existingRoot?.id ?? this.options.createId();
      const rootRequestId = this.options.createId();
      const runId = this.options.createId();
      const outboxId = this.options.createId();
      const now = this.options.now();
      const userMessage: RuntimeMessage = {
        role: 'user',
        content: prompt,
        timestamp: now.getTime(),
      };

      if (!existingRoot) {
        await transaction.insert(conversationMessages).values({
          id: messageId,
          branchId: input.branchId,
          role: 'user',
          sequence: messageSequence,
          content: encodeRuntimeMessage(userMessage),
          stable: true,
          createdAt: now,
        });
      }
      if (actionEnvelope.source === 'free_text') {
        await transaction
          .update(conversations)
          .set({ title: prompt.slice(0, 24), updatedAt: now })
          .where(
            and(eq(conversations.id, branch.conversationId), eq(conversations.title, '新对话')),
          );
      }
      await transaction.insert(rootRequests).values({
        id: rootRequestId,
        branchId: input.branchId,
        messageId,
        requestedByUserId: input.userId,
        idempotencyKey: input.idempotencyKey,
        actionEnvelope,
        createdAt: now,
      });
      await transaction.insert(agentRuns).values({
        id: runId,
        workspaceId: branch.workspaceId,
        branchId: input.branchId,
        rootRequestId,
        mode: 'direct',
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      });
      const contextPack = await this.options.contexts.prepare(transaction, {
        runId,
        branchId: input.branchId,
        rootMessageSequence: existingRoot?.sequence ?? messageSequence,
        query: prompt,
        workspaceId: branch.workspaceId,
        userId: input.userId,
        mentionTargetIds: input.mentionTargetIds ?? [],
        attachmentIds: input.attachmentIds ?? [],
        skills: selectedSkills,
        contextBindings: [
          ...(actionEnvelope.source === 'free_text' && branch.articleId
            ? ([{ type: 'mention', targetId: branch.articleId }] as const)
            : []),
          ...(input.contextBindings ?? []),
        ],
      });
      const queued = await appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: 'run.queued',
        payload: {
          mode: 'direct' as const,
          rootRequestId,
          contextManifest: contextPack.manifest,
          contextHash: contextPack.contentHash,
        },
      });
      if (this.options.skillPreselector || selectedSkills.length > 0) {
        await appendRunEvent(transaction, {
          id: this.options.createId(),
          runId,
          eventType: 'skill.selection.completed',
          payload: {
            explicit: explicitSkills,
            model: modelSkills,
            selected: selectedSkills,
            ...(modelSelectionFailure
              ? {
                  modelSelection: {
                    status: 'failed',
                    code: modelSelectionFailure.code,
                  },
                }
              : {}),
          },
        });
      }
      if (this.options.dispatchCommands) {
        await enqueueOutboxMessage(transaction, {
          id: outboxId,
          aggregateType: 'AgentRun',
          aggregateId: runId,
          topic: AGENT_RUN_COMMAND_TOPIC,
          messageKey: runId,
          payload: { command: 'run.execute', messageId: outboxId, runId },
          occurredAt: now,
        });
      }
      return {
        result: {
          runId,
          rootRequestId,
          messageId,
          status: 'queued' as const,
          mode: 'direct' as const,
          created: true,
        },
        event: toDurableEvent(queued),
      };
    });

    if (result.event) {
      await this.options.publisher.publish({ durable: true, event: result.event });
    }
    return result.result;
  }
}

function collectSkillSelections(input: CreateDirectRunInput): readonly SelectedSkillInput[] {
  return normalizeSkillSelections([
    ...(input.skills ?? []),
    ...(input.contextBindings ?? []).flatMap((binding) =>
      binding.type === 'skill' ? [{ skillId: binding.skillId, version: binding.version }] : [],
    ),
  ]);
}

function mergeSkillSelections(
  explicit: readonly SelectedSkillInput[],
  model: readonly SelectedSkillInput[],
): readonly SelectedSkillInput[] {
  const selected = new Map(normalizeSkillSelections(explicit).map((item) => [item.skillId, item]));
  for (const selection of model) {
    if (!selected.has(selection.skillId)) selected.set(selection.skillId, selection);
  }
  if (selected.size > 8) {
    throw new AgentApplicationError('invalid_context', 'A Run can select at most 8 Skills');
  }
  return [...selected.values()].sort((left, right) => left.skillId.localeCompare(right.skillId));
}

function normalizeSkillSelections(
  selections: readonly SelectedSkillInput[],
): readonly SelectedSkillInput[] {
  const selected = new Map<string, SelectedSkillInput>();
  for (const selection of selections) {
    const current = selected.get(selection.skillId);
    if (current && current.version !== selection.version) {
      throw new AgentApplicationError(
        'invalid_context',
        `Skill ${selection.skillId} cannot use multiple revisions in one Run`,
      );
    }
    selected.set(selection.skillId, selection);
  }
  return [...selected.values()];
}

function validateModelSkillSelections(
  candidates: readonly SkillPreselectionCandidate[],
  selections: readonly SelectedSkillInput[],
): readonly SelectedSkillInput[] {
  const byId = new Map(candidates.map((candidate) => [candidate.skillId, candidate]));
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.skillId)) {
      throw new AgentApplicationError(
        'invalid_context',
        `Model selected Skill ${selection.skillId} more than once`,
      );
    }
    seen.add(selection.skillId);
    const candidate = byId.get(selection.skillId);
    if (
      candidate?.version !== selection.version ||
      candidate.hidden ||
      candidate.disableModelInvocation
    ) {
      throw new AgentApplicationError(
        'invalid_context',
        `Model selected unavailable Skill ${selection.skillId}@${selection.version}`,
      );
    }
  }
  return [...selections];
}

async function loadSkillPreselectionCandidates(
  transaction: DatabaseTransaction,
  workspaceId: string,
): Promise<readonly SkillPreselectionCandidate[]> {
  const rows = await transaction
    .select()
    .from(skillRevisions)
    .where(eq(skillRevisions.workspaceId, workspaceId))
    .orderBy(skillRevisions.skillId, desc(skillRevisions.createdAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latest.has(row.skillId)) latest.set(row.skillId, row);
  }
  return [...latest.values()].map((row) => {
    const skill = loadSkill(row.content);
    if (skill.id !== row.skillId || skill.version !== row.version) {
      throw new AgentApplicationError(
        'invalid_context',
        `Stored Skill ${row.skillId}@${row.version} has an invalid identity`,
      );
    }
    return {
      skillId: row.skillId,
      version: row.version,
      description: skill.description,
      allowedTools: row.allowedTools,
      hidden: skill.hidden === true,
      disableModelInvocation: skill.disableModelInvocation === true,
    };
  });
}

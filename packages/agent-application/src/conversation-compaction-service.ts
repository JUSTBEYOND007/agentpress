import { randomUUID } from 'node:crypto';

import {
  collectConversationCompactionPreserveData,
  conversationMessages,
  type AppendConversationCompactionInput,
  type AgentPressDatabase,
  appendConversationCompaction,
  getEffectiveConversationCompaction,
} from '@agentpress/database';
import {
  planConversationCompaction,
  resolveCompactionBudget,
  resolveCompactionKeepTokens,
  shouldCompactConversation,
} from '@agentpress/agent-context';
import { and, asc, eq } from 'drizzle-orm';

import {
  CONVERSATION_COMPACTION_PROMPT_VERSION,
  ConversationSummaryGenerationError,
  type ConversationSummaryMessage,
  type ConversationSummaryGeneration,
  PiConversationSummaryGenerator,
} from './pi-conversation-summary-generator.js';
import type { AgentRuntimeFactory } from './contracts.js';

export type ConversationCompactionResult =
  | { readonly status: 'not_needed'; readonly reason: 'below_threshold' | 'no_complete_turn' }
  | { readonly status: 'completed'; readonly compactionId: string; readonly version: number }
  | { readonly status: 'failed'; readonly compactionId: string; readonly version: number };

type ConversationCompactionMessageRow = {
  readonly sequence: number;
  readonly role: string;
  readonly content: readonly unknown[];
};

export type ConversationCompactionPersistence = {
  readonly loadMessages: (branchId: string) => Promise<readonly ConversationCompactionMessageRow[]>;
  readonly getEffective: (branchId: string) => Promise<
    | {
        readonly id: string;
        readonly summary: string | null;
        readonly firstKeptMessageSequence: number | null;
      }
    | undefined
  >;
  readonly collectPreserveData: (
    branchId: string,
    sourceThroughSequence: number,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly append: (
    input: AppendConversationCompactionInput,
  ) => Promise<{ readonly id: string; readonly version: number }>;
};

export type ConversationSummaryGenerator = {
  readonly generate: PiConversationSummaryGenerator['generate'];
};

export class ConversationCompactionService {
  private readonly generator: ConversationSummaryGenerator;
  private readonly persistence: ConversationCompactionPersistence;
  private readonly createId: () => string;

  public constructor(
    private readonly options: {
      readonly database?: AgentPressDatabase;
      readonly runtimeFactory?: AgentRuntimeFactory;
      readonly persistence?: ConversationCompactionPersistence;
      readonly generator?: ConversationSummaryGenerator;
      readonly contextWindow?: number;
      readonly keepRecentTokens?: number;
      readonly reserveTokens?: number;
      readonly timeoutMs?: number;
      readonly createId?: () => string;
    },
  ) {
    this.createId = options.createId ?? randomUUID;
    this.persistence =
      options.persistence ?? databasePersistence(requiredDatabase(options.database));
    this.generator =
      options.generator ??
      new PiConversationSummaryGenerator({
        runtimeFactory: requiredRuntimeFactory(options.runtimeFactory),
        createId: this.createId,
      });
  }

  public async compact(input: {
    readonly branchId: string;
    readonly reason: 'automatic' | 'manual' | 'mid_turn';
    readonly force?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<ConversationCompactionResult> {
    const rows = await this.persistence.loadMessages(input.branchId);
    const previous = await this.persistence.getEffective(input.branchId);
    const sourceFromSequence = previous?.firstKeptMessageSequence ?? rows[0]?.sequence;
    if (sourceFromSequence === undefined) {
      return { status: 'not_needed', reason: 'no_complete_turn' };
    }
    const messages = rows
      .filter(({ sequence }) => sequence >= sourceFromSequence)
      .map(toSummaryMessage);
    const budget = resolveCompactionBudget(
      this.options.contextWindow ?? 128_000,
      this.options.reserveTokens,
    );
    const estimatedTokens =
      (previous?.summary ? estimateTokens(previous.summary) : 0) +
      messages.reduce((total, message) => total + estimateTokens(message.content), 0);
    if (
      !input.force &&
      !shouldCompactConversation(estimatedTokens, this.options.contextWindow ?? 128_000, budget)
    ) {
      return { status: 'not_needed', reason: 'below_threshold' };
    }
    const plan = planConversationCompaction({
      messages: messages.map((message) => ({
        sequence: message.sequence,
        role: message.role,
        tokenCount: estimateTokens(message.content),
      })),
      sourceFromSequence,
      keepRecentTokens: resolveCompactionKeepTokens(
        this.options.contextWindow ?? 128_000,
        budget,
        this.options.keepRecentTokens ?? 20_000,
      ),
    });
    if (!plan) return { status: 'not_needed', reason: 'no_complete_turn' };
    const preserveData = await this.persistence.collectPreserveData(
      input.branchId,
      plan.sourceThroughSequence,
    );
    const tokensBefore =
      plan.tokensBefore + (previous?.summary ? estimateTokens(previous.summary) : 0);
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs ?? 90_000);
    const generationSignal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    let generated: ConversationSummaryGeneration;
    try {
      generated = await this.generator.generate({
        branchId: input.branchId,
        ...(previous?.summary ? { previousSummary: previous.summary } : {}),
        messages: messages.filter(({ sequence }) => sequence <= plan.sourceThroughSequence),
        preserveData,
        signal: generationSignal,
      });
    } catch (error) {
      const generationError =
        timeoutSignal.aborted && !input.signal?.aborted
          ? new ConversationSummaryGenerationError(
              'timeout',
              'Conversation summary generation timed out',
              true,
              error instanceof ConversationSummaryGenerationError ? error.model : 'unknown/unknown',
            )
          : asGenerationError(error);
      const failed = await this.persistence.append({
        id: this.createId(),
        branchId: input.branchId,
        reason: input.reason,
        sourceFromSequence: plan.sourceFromSequence,
        sourceThroughSequence: plan.sourceThroughSequence,
        tokensBefore,
        model: generationError.model,
        promptVersion: CONVERSATION_COMPACTION_PROMPT_VERSION,
        reserveTokens: budget.reserveTokens,
        reserveProvenance: budget.provenance,
        preserveData,
        failure: {
          code: generationError.code,
          message: generationError.message,
          retryable: generationError.retryable,
        },
      });
      return { status: 'failed', compactionId: failed.id, version: failed.version };
    }
    const persisted = await this.persistence.append({
      id: this.createId(),
      branchId: input.branchId,
      reason: input.reason,
      sourceFromSequence: plan.sourceFromSequence,
      sourceThroughSequence: plan.sourceThroughSequence,
      firstKeptMessageSequence: plan.firstKeptMessageSequence,
      summary: generated.summary,
      ...(generated.shortSummary ? { shortSummary: generated.shortSummary } : {}),
      tokensBefore,
      tokenCount: generated.tokenCount,
      preserveData,
      model: generated.model,
      promptVersion: generated.promptVersion,
      reserveTokens: budget.reserveTokens,
      reserveProvenance: budget.provenance,
    });
    return { status: 'completed', compactionId: persisted.id, version: persisted.version };
  }
}

function toSummaryMessage(row: {
  readonly sequence: number;
  readonly role: string;
  readonly content: readonly unknown[];
}): ConversationSummaryMessage {
  const envelope = row.content[0];
  if (
    isRecord(envelope) &&
    isRecord(envelope.message) &&
    typeof envelope.message.content === 'string'
  ) {
    return {
      sequence: row.sequence,
      role: normalizeRole(row.role),
      content: envelope.message.content,
    };
  }
  return {
    sequence: row.sequence,
    role: normalizeRole(row.role),
    content: JSON.stringify(row.content),
  };
}

function normalizeRole(role: string): ConversationSummaryMessage['role'] {
  return role === 'system' || role === 'tool' || role === 'assistant' ? role : 'user';
}

function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4));
}

function asGenerationError(error: unknown): ConversationSummaryGenerationError {
  if (error instanceof ConversationSummaryGenerationError) return error;
  return new ConversationSummaryGenerationError(
    'provider_failure',
    error instanceof Error ? error.message : 'Conversation summary generation failed',
    true,
    'unknown/unknown',
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function databasePersistence(database: AgentPressDatabase): ConversationCompactionPersistence {
  return {
    loadMessages: (branchId) =>
      database
        .select({
          sequence: conversationMessages.sequence,
          role: conversationMessages.role,
          content: conversationMessages.content,
        })
        .from(conversationMessages)
        .where(
          and(eq(conversationMessages.branchId, branchId), eq(conversationMessages.stable, true)),
        )
        .orderBy(asc(conversationMessages.sequence)),
    getEffective: (branchId) =>
      getEffectiveConversationCompaction(database, branchId, Number.MAX_SAFE_INTEGER),
    collectPreserveData: (branchId, sourceThroughSequence) =>
      collectConversationCompactionPreserveData(database, branchId, sourceThroughSequence),
    append: (input) => appendConversationCompaction(database, input),
  };
}

function requiredDatabase(database: AgentPressDatabase | undefined): AgentPressDatabase {
  if (!database) throw new Error('Conversation compaction requires a database or persistence port');
  return database;
}

function requiredRuntimeFactory(
  runtimeFactory: AgentRuntimeFactory | undefined,
): AgentRuntimeFactory {
  if (!runtimeFactory) {
    throw new Error('Conversation compaction requires a runtime factory or summary generator');
  }
  return runtimeFactory;
}

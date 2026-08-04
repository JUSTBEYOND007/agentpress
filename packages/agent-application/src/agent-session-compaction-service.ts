import {
  planRuntimeCompaction,
  resolveCompactionBudget,
  resolveCompactionKeepTokens,
} from '@agentpress/agent-context';
import type {
  RuntimeContextCompactionMessage,
  RuntimeContextCompactionRequest,
  RuntimeContextCompactionResult,
} from '@agentpress/agent-runtime';
import {
  agentSessions,
  agentRuns,
  agentTranscriptEntries,
  appendAgentSessionCompaction,
  type AgentPressDatabase,
  collectConversationCompactionPreserveData,
  getEffectiveAgentSessionCompaction,
} from '@agentpress/database';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { AgentRuntimeFactory } from './contracts.js';
import {
  CONVERSATION_COMPACTION_PROMPT_VERSION,
  ConversationSummaryGenerationError,
  PiConversationSummaryGenerator,
} from './pi-conversation-summary-generator.js';

const CONTEXT_MESSAGE_TYPES = ['history', 'current_turn', 'message', 'tool_result'] as const;

type ContextTranscriptEntry = {
  readonly id: string;
  readonly sequence: number;
  readonly role: string;
};

export class AgentSessionCompactionService {
  private readonly generator: PiConversationSummaryGenerator;

  public constructor(
    private readonly options: {
      readonly database: AgentPressDatabase;
      readonly runtimeFactory: AgentRuntimeFactory;
      readonly createId: () => string;
      readonly now: () => Date;
      readonly keepRecentTokens?: number;
      readonly timeoutMs?: number;
    },
  ) {
    this.generator = new PiConversationSummaryGenerator({
      runtimeFactory: options.runtimeFactory,
      createId: options.createId,
      now: options.now,
    });
  }

  public async compact(
    input: RuntimeContextCompactionRequest,
  ): Promise<RuntimeContextCompactionResult> {
    const budget = resolveCompactionBudget(input.contextWindow, input.reserveTokens);
    let plan;
    try {
      plan = planRuntimeCompaction({
        messages: input.messages,
        keepRecentTokens: resolveCompactionKeepTokens(
          input.contextWindow,
          budget,
          this.options.keepRecentTokens ?? 20_000,
        ),
      });
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Invalid runtime compaction context',
      };
    }
    if (!plan) return { status: 'not_needed' };
    if (input.messages.find(({ index }) => index === plan.sourceThroughIndex)?.role === 'summary') {
      return { status: 'not_needed' };
    }

    const [sessionRows, previous, transcript] = await Promise.all([
      this.options.database
        .select({
          runId: agentSessions.runId,
          taskId: agentSessions.taskId,
          branchId: agentRuns.branchId,
        })
        .from(agentSessions)
        .innerJoin(agentRuns, eq(agentRuns.id, agentSessions.runId))
        .where(eq(agentSessions.id, input.runId))
        .limit(1),
      getEffectiveAgentSessionCompaction(this.options.database, input.runId),
      this.options.database
        .select({
          id: agentTranscriptEntries.id,
          sequence: agentTranscriptEntries.sequence,
          role: agentTranscriptEntries.role,
        })
        .from(agentTranscriptEntries)
        .where(
          and(
            eq(agentTranscriptEntries.sessionId, input.runId),
            inArray(agentTranscriptEntries.messageType, [...CONTEXT_MESSAGE_TYPES]),
          ),
        )
        .orderBy(asc(agentTranscriptEntries.sequence)),
    ]);
    const session = sessionRows[0];
    if (!session) return { status: 'failed', message: 'Agent Session does not exist' };

    const mapped = mapContextToTranscript(input.messages, transcript, previous);
    if (!mapped) {
      return {
        status: 'failed',
        message: 'Runtime context does not match the persisted Agent Session transcript',
      };
    }
    const sourceFromSequence = mapped.sequenceForIndex(plan.sourceFromIndex);
    const sourceThroughSequence = mapped.sequenceForIndex(plan.sourceThroughIndex);
    const firstKeptSequence = mapped.sequenceForIndex(plan.firstKeptMessageIndex);
    if (
      sourceFromSequence === undefined ||
      sourceThroughSequence === undefined ||
      firstKeptSequence === undefined
    ) {
      return { status: 'failed', message: 'Runtime compaction boundary is not persisted' };
    }
    const sourceEntries = transcript.filter(
      ({ sequence }) => sequence >= sourceFromSequence && sequence <= sourceThroughSequence,
    );
    const protectedFacts = await collectConversationCompactionPreserveData(
      this.options.database,
      session.branchId,
      Number.MAX_SAFE_INTEGER,
    );
    const preserveData = {
      ...protectedFacts,
      runId: session.runId,
      sessionId: input.runId,
      ...(session.taskId ? { taskId: session.taskId } : {}),
      transcriptEntryIds: sourceEntries.map(({ id }) => id),
    };
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs ?? 90_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    try {
      const generated = await this.generator.generate({
        branchId: input.runId,
        ...(previous?.summary ? { previousSummary: previous.summary } : {}),
        messages: input.messages
          .filter(
            (message) => message.index <= plan.sourceThroughIndex && message.role !== 'summary',
          )
          .map((message) => ({
            sequence: message.index + 1,
            role: summaryRole(message.role),
            content: message.content,
          })),
        preserveData,
        signal,
      });
      const persisted = await appendAgentSessionCompaction(this.options.database, {
        id: this.options.createId(),
        sessionId: input.runId,
        reason: input.reason,
        sourceFromSequence,
        sourceThroughSequence,
        firstKeptSequence,
        summary: generated.summary,
        tokensBefore: plan.tokensBefore,
        tokenCount: generated.tokenCount,
        preserveData,
        model: generated.model,
        promptVersion: generated.promptVersion,
        reserveTokens: budget.reserveTokens,
        reserveProvenance: budget.provenance,
      });
      return {
        status: 'completed',
        compactionId: persisted.id,
        summary: persisted.summary ?? generated.summary,
        firstKeptMessageIndex: plan.firstKeptMessageIndex,
        tokensBefore: persisted.tokensBefore,
        tokenCount: persisted.tokenCount ?? generated.tokenCount,
      };
    } catch (error) {
      const failure = asCompactionFailure(error, timeoutSignal, input.signal);
      const persisted = await appendAgentSessionCompaction(this.options.database, {
        id: this.options.createId(),
        sessionId: input.runId,
        reason: input.reason,
        sourceFromSequence,
        sourceThroughSequence,
        tokensBefore: plan.tokensBefore,
        preserveData,
        model: failure.model,
        promptVersion: CONVERSATION_COMPACTION_PROMPT_VERSION,
        reserveTokens: budget.reserveTokens,
        reserveProvenance: budget.provenance,
        failure: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
      });
      return { status: 'failed', compactionId: persisted.id, message: failure.message };
    }
  }
}

function mapContextToTranscript(
  messages: readonly RuntimeContextCompactionMessage[],
  transcript: readonly ContextTranscriptEntry[],
  previous:
    | { readonly firstKeptSequence: number | null; readonly summary: string | null }
    | undefined,
): { readonly sequenceForIndex: (index: number) => number | undefined } | undefined {
  const beginsWithSummary = messages[0]?.role === 'summary';
  if (beginsWithSummary && !previous?.firstKeptSequence) return undefined;
  const visibleMessages = messages.filter(({ role }) => role !== 'summary');
  const available = transcript.filter(
    ({ sequence }) => !beginsWithSummary || sequence >= (previous?.firstKeptSequence ?? 0),
  );
  if (available.length < visibleMessages.length) return undefined;
  const sequenceByIndex = new Map<number, number>();
  if (beginsWithSummary && previous?.firstKeptSequence) {
    sequenceByIndex.set(messages[0]?.index ?? -1, previous.firstKeptSequence);
  }
  for (const [position, message] of visibleMessages.entries()) {
    const entry = available[position];
    if (!entry || normalizeTranscriptRole(entry.role) !== message.role) return undefined;
    sequenceByIndex.set(message.index, entry.sequence);
  }
  return { sequenceForIndex: (index) => sequenceByIndex.get(index) };
}

function normalizeTranscriptRole(role: string): RuntimeContextCompactionMessage['role'] {
  if (role === 'tool') return 'tool';
  if (role === 'assistant') return 'assistant';
  if (role === 'application') return 'application';
  return 'user';
}

function summaryRole(
  role: RuntimeContextCompactionMessage['role'],
): 'system' | 'user' | 'assistant' | 'tool' {
  if (role === 'assistant' || role === 'tool') return role;
  return 'user';
}

function asCompactionFailure(
  error: unknown,
  timeoutSignal: AbortSignal,
  inputSignal: AbortSignal | undefined,
): ConversationSummaryGenerationError {
  if (timeoutSignal.aborted && !inputSignal?.aborted) {
    return new ConversationSummaryGenerationError(
      'timeout',
      'Agent Session compaction timed out',
      true,
      error instanceof ConversationSummaryGenerationError ? error.model : 'unknown/unknown',
    );
  }
  if (error instanceof ConversationSummaryGenerationError) return error;
  return new ConversationSummaryGenerationError(
    'provider_failure',
    error instanceof Error ? error.message : 'Agent Session compaction failed',
    true,
    'unknown/unknown',
  );
}

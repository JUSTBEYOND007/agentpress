import type {
  RuntimeCurrentTurn,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeResult,
  RuntimeTool,
  RuntimeToolChoice,
  RuntimeTranscriptMessage,
} from '@agentpress/agent-runtime';
import {
  agentSessions,
  agentTranscriptEntries,
  type AgentPressDatabase,
  modelSelections,
  ToolChoiceQueueStore,
} from '@agentpress/database';
import { eq, max, sql } from 'drizzle-orm';

import { withHistoricalIntentBoundary } from './agent-transcript-projector.js';
import type { AgentRuntimeFactory } from './contracts.js';

type AgentSessionRunnerOptions = {
  readonly database: AgentPressDatabase;
  readonly runtimeFactory: AgentRuntimeFactory;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly onRuntimeEvent: (runId: string, event: RuntimeEvent) => Promise<void>;
};

export class AgentSessionRunner {
  private readonly activeMainRuntimes = new Map<
    string,
    ReturnType<AgentRuntimeFactory['create']>
  >();
  private readonly toolChoices: ToolChoiceQueueStore;

  public constructor(private readonly options: AgentSessionRunnerOptions) {
    this.toolChoices = new ToolChoiceQueueStore(options.database, options.createId, options.now);
  }

  public steerActiveMain(runId: string, content: string): boolean {
    const runtime = this.activeMainRuntimes.get(runId);
    return (
      runtime?.steer?.({ role: 'user', content, timestamp: this.options.now().getTime() }) ?? false
    );
  }

  public enqueueToolChoice(
    runId: string,
    choice: RuntimeToolChoice,
    label: string,
  ): Promise<{ readonly id: string; readonly sequence: number }> {
    return this.toolChoices.enqueue({ runId, choice, label });
  }

  public async execute(
    runId: string,
    taskId: string | undefined,
    kind: 'main' | 'specialist',
    attempt: number,
    modelPurpose: string,
    systemPrompt: string,
    history: readonly RuntimeTranscriptMessage[],
    currentTurn: RuntimeCurrentTurn,
    tools: readonly RuntimeTool[],
    signal?: AbortSignal,
    continuation = false,
  ): Promise<RuntimeResult> {
    const runtime = this.options.runtimeFactory.create(modelPurpose);
    const selectedModel = runtime.identity?.model ?? modelPurpose;
    const logicalKey = taskId
      ? `${runId}:task:${taskId}:${String(attempt)}`
      : `${runId}:main:${String(attempt)}`;
    const sessionRows = await this.options.database
      .insert(agentSessions)
      .values({
        id: this.options.createId(),
        runId,
        ...(taskId ? { taskId } : {}),
        kind,
        attempt,
        logicalKey,
        model: selectedModel,
      })
      .onConflictDoUpdate({
        target: agentSessions.logicalKey,
        set: { status: 'active', model: selectedModel, updatedAt: this.options.now() },
      })
      .returning({ id: agentSessions.id });
    const sessionId = sessionRows[0]?.id;
    if (!sessionId) throw new Error(`Unable to initialize Agent Session ${logicalKey}`);
    await this.options.database.insert(modelSelections).values({
      id: this.options.createId(),
      runId,
      ...(taskId ? { taskId } : {}),
      purpose: modelPurpose,
      policySnapshot: {
        purpose: modelPurpose,
        provider: runtime.identity?.provider ?? 'unknown',
        ...(runtime.identity?.contextWindow
          ? { contextWindow: runtime.identity.contextWindow }
          : {}),
        ...(runtime.identity?.maxOutputTokens
          ? { maxOutputTokens: runtime.identity.maxOutputTokens }
          : {}),
      },
      selectedModel,
      fallbackUsed: false,
    });
    const record = (
      role: string,
      messageType: string,
      content: Readonly<Record<string, unknown>>,
      providerToolCallId?: string,
    ) => this.record(sessionId, role, messageType, content, providerToolCallId);
    const governedSystemPrompt = withHistoricalIntentBoundary(systemPrompt, history.length > 0);
    await record('system', 'system_prompt', { content: governedSystemPrompt });
    for (const message of history) {
      await record(
        message.role,
        'history',
        { message },
        message.role === 'tool' ? message.toolCallId : undefined,
      );
    }
    await record('application', 'current_turn', { currentTurn });
    if (kind === 'main') this.activeMainRuntimes.set(runId, runtime);
    const toolChoiceClaimToken = kind === 'main' ? this.options.createId() : undefined;
    const claimedToolChoice = toolChoiceClaimToken
      ? await this.toolChoices.claimNext({ runId, claimToken: toolChoiceClaimToken })
      : undefined;
    let result: RuntimeResult;
    try {
      result = await runtime.execute(
        {
          runId: sessionId,
          systemPrompt: governedSystemPrompt,
          history,
          currentTurn,
          tools,
          continuation,
          ...(claimedToolChoice ? { toolChoice: claimedToolChoice.choice } : {}),
          ...(kind === 'specialist' ? { maxToolCalls: 12, maxFailedCompletionCalls: 2 } : {}),
        },
        async (event) => {
          if (event.type === 'message.completed') {
            await record(event.message.role, 'message', { message: event.message });
          } else if (event.type === 'tool.started') {
            await record(
              'assistant',
              'tool_call',
              { name: event.toolName, arguments: event.arguments },
              event.toolCallId,
            );
          } else if (event.type === 'tool.completed') {
            await record('tool', 'tool_result', { result: event.result }, event.result.toolCallId);
          }
          await this.options.onRuntimeEvent(runId, event);
        },
        signal,
      );
    } catch (error) {
      result = protocolFailure(
        [],
        error instanceof Error ? error.message : 'Unknown Pi runtime error',
      );
    }
    if (kind === 'main' && this.activeMainRuntimes.get(runId) === runtime) {
      this.activeMainRuntimes.delete(runId);
    }
    if (claimedToolChoice && toolChoiceClaimToken) {
      const satisfied = isToolChoiceSatisfied(claimedToolChoice.choice, result.messages);
      const settled = await this.toolChoices.settle({
        id: claimedToolChoice.id,
        claimToken: toolChoiceClaimToken,
        status:
          result.status === 'cancelled'
            ? 'cancelled'
            : result.status === 'completed' && satisfied
              ? 'resolved'
              : 'rejected',
        ...(result.status === 'cancelled'
          ? { reason: 'aborted' }
          : result.status === 'failed'
            ? { reason: 'error' }
            : satisfied
              ? {}
              : { reason: 'not_invoked' }),
      });
      if (!settled) {
        result = protocolFailure(
          result.messages,
          'Tool choice claim was superseded by Run recovery',
        );
      }
    }
    await this.options.database
      .update(agentSessions)
      .set({
        status: result.status === 'completed' ? 'completed' : 'failed',
        updatedAt: this.options.now(),
      })
      .where(eq(agentSessions.id, sessionId));
    return result;
  }

  private async record(
    sessionId: string,
    role: string,
    messageType: string,
    content: Readonly<Record<string, unknown>>,
    providerToolCallId?: string,
  ): Promise<void> {
    await this.options.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${agentSessions} where id = ${sessionId} for update`,
      );
      const sequenceRows = await transaction
        .select({ nextSequence: agentSessions.nextSequence })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1);
      const existingRows = await transaction
        .select({ maxSequence: max(agentTranscriptEntries.sequence) })
        .from(agentTranscriptEntries)
        .where(eq(agentTranscriptEntries.sessionId, sessionId));
      const persistedNext = sequenceRows[0]?.nextSequence;
      if (!persistedNext) throw new Error(`Agent Session ${sessionId} has no transcript sequence`);
      const sequence = Math.max(persistedNext, (existingRows[0]?.maxSequence ?? 0) + 1);
      await transaction.insert(agentTranscriptEntries).values({
        id: this.options.createId(),
        sessionId,
        sequence,
        role,
        messageType,
        content,
        ...(providerToolCallId ? { providerToolCallId } : {}),
      });
      await transaction
        .update(agentSessions)
        .set({ nextSequence: sequence + 1, updatedAt: this.options.now() })
        .where(eq(agentSessions.id, sessionId));
    });
  }
}

export function isToolChoiceSatisfied(
  choice: RuntimeToolChoice,
  messages: readonly RuntimeMessage[],
): boolean {
  const calls = messages.flatMap((message) =>
    message.role === 'assistant'
      ? (message.blocks ?? []).filter((block) => block.type === 'tool_call')
      : [],
  );
  if (choice === 'required') return calls.length > 0;
  if (choice === 'none') return calls.length === 0;
  if (choice === 'auto') return true;
  return calls.some(({ name }) => name === choice.name);
}

function protocolFailure(messages: readonly RuntimeMessage[], message: string): RuntimeResult {
  return {
    status: 'failed',
    messages,
    error: { code: 'protocol_error', message, retryable: true },
  };
}

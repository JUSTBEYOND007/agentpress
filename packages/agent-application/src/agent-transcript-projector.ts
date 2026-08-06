import type {
  RuntimeAssistantMessage,
  RuntimeMessage,
  RuntimeTranscriptMessage,
  RuntimeUserMessage,
} from '@agentpress/agent-runtime';
import {
  agentSessions,
  agentTranscriptEntries,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, asc, desc, eq } from 'drizzle-orm';
import { ExecutionFactCache, executionFactKey } from './execution-fact-cache.js';

const DEFAULT_DIALOGUE_LIMIT = 12;
const DEFAULT_TOOL_SUMMARY_LIMIT = 8;
const emptyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

type TranscriptEntry = {
  readonly sessionId?: string;
  readonly sessionStatus: string;
  readonly sequence?: number;
  readonly role?: string;
  readonly messageType: string;
  readonly providerToolCallId?: string | null;
  readonly content: Readonly<Record<string, unknown>>;
};

export class AgentTranscriptProjector {
  private readonly projectionCache = new ExecutionFactCache<readonly RuntimeTranscriptMessage[]>(
    64,
  );

  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async interruptActive(runId: string): Promise<void> {
    await this.database
      .update(agentSessions)
      .set({ status: 'interrupted', updatedAt: this.now() })
      .where(and(eq(agentSessions.runId, runId), eq(agentSessions.status, 'active')));
  }

  public async restoreCommitted(
    runId: string,
    taskId?: string,
  ): Promise<readonly RuntimeTranscriptMessage[]> {
    const rows = await this.database
      .select({
        sessionId: agentSessions.id,
        sessionStatus: agentSessions.status,
        sequence: agentTranscriptEntries.sequence,
        role: agentTranscriptEntries.role,
        messageType: agentTranscriptEntries.messageType,
        providerToolCallId: agentTranscriptEntries.providerToolCallId,
        content: agentTranscriptEntries.content,
      })
      .from(agentTranscriptEntries)
      .innerJoin(agentSessions, eq(agentSessions.id, agentTranscriptEntries.sessionId))
      .where(
        taskId
          ? and(eq(agentSessions.runId, runId), eq(agentSessions.taskId, taskId))
          : and(eq(agentSessions.runId, runId), eq(agentSessions.kind, 'main')),
      )
      .orderBy(asc(agentSessions.createdAt), asc(agentTranscriptEntries.sequence));
    const key = executionFactKey({ runId, taskId: taskId ?? null, rows });
    const cached = this.projectionCache.get(key);
    if (cached) return cached;
    const projection = projectCommittedTranscript(rows);
    this.projectionCache.set(key, projection);
    return projection;
  }

  public async restoreApprovedToolCall(
    runId: string,
    taskId: string,
    providerToolCallId: string,
  ): Promise<RuntimeAssistantMessage | undefined> {
    const rows = await this.database
      .select({ content: agentTranscriptEntries.content })
      .from(agentTranscriptEntries)
      .innerJoin(agentSessions, eq(agentSessions.id, agentTranscriptEntries.sessionId))
      .where(
        and(
          eq(agentSessions.runId, runId),
          eq(agentSessions.taskId, taskId),
          eq(agentTranscriptEntries.role, 'assistant'),
          eq(agentTranscriptEntries.messageType, 'message'),
        ),
      )
      .orderBy(desc(agentTranscriptEntries.createdAt))
      .limit(1);
    const message = rows[0]?.content.message;
    if (!isRuntimeAssistantMessage(message)) return undefined;
    return message.blocks?.some(
      (block) => block.type === 'tool_call' && block.id === providerToolCallId,
    )
      ? message
      : undefined;
  }
}

export function projectConversationHistory(
  messages: readonly RuntimeMessage[],
  limit = DEFAULT_DIALOGUE_LIMIT,
): readonly RuntimeMessage[] {
  const natural: RuntimeMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.content.trim()) natural.push(message);
      continue;
    }
    const normalized = naturalAssistantMessage(message);
    if (normalized.content.trim()) natural.push(normalized);
  }
  return natural.slice(-limit);
}

export function readConversationCompactionBoundary(
  manifest: Readonly<Record<string, unknown>>,
  branchId: string,
  beforeMessageSequence: number,
): number | undefined {
  const reference = manifest.conversationCompaction;
  if (!isRecord(reference)) return undefined;
  const firstKept = reference.firstKeptMessageSequence;
  const sourceThrough = reference.sourceThroughSequence;
  if (
    reference.branchId !== branchId ||
    typeof reference.id !== 'string' ||
    typeof reference.version !== 'number' ||
    !Number.isSafeInteger(reference.version) ||
    reference.version < 1 ||
    typeof sourceThrough !== 'number' ||
    !Number.isSafeInteger(sourceThrough) ||
    typeof firstKept !== 'number' ||
    !Number.isSafeInteger(firstKept) ||
    firstKept <= sourceThrough ||
    firstKept > beforeMessageSequence
  ) {
    return undefined;
  }
  return firstKept;
}

export function projectCommittedTranscript(
  entries: readonly TranscriptEntry[],
  dialogueLimit = DEFAULT_DIALOGUE_LIMIT,
  toolSummaryLimit = DEFAULT_TOOL_SUMMARY_LIMIT,
): readonly RuntimeTranscriptMessage[] {
  const dialogue: RuntimeMessage[] = [];
  const toolSummaries: {
    readonly toolName: string;
    readonly content: string;
    readonly isError: boolean;
  }[] = [];
  const toolProtocols = new Map<
    string,
    {
      callCount: number;
      resultCount: number;
      toolName?: string;
      result?: {
        readonly toolName: string;
        readonly content: string;
        readonly isError: boolean;
        readonly timestamp: number;
      };
      resultOrder?: number;
    }
  >();
  let latestTimestamp = 0;
  let entryOrder = 0;

  for (const entry of entries) {
    entryOrder += 1;
    if (entry.sessionStatus !== 'completed') continue;
    if (entry.messageType === 'message') {
      const message = entry.content.message;
      if (!isRuntimeMessage(message)) continue;
      latestTimestamp = Math.max(latestTimestamp, message.timestamp);
      if (message.role === 'user') {
        if (message.content.trim()) dialogue.push(message);
      } else {
        const normalized = naturalAssistantMessage(message);
        if (normalized.content.trim()) dialogue.push(normalized);
      }
      continue;
    }
    const providerToolCallId = entry.providerToolCallId;
    if (entry.messageType === 'tool_call' && providerToolCallId) {
      const toolName = entry.content.name;
      if (typeof toolName !== 'string') continue;
      const key = toolProtocolKey(entry.sessionId, providerToolCallId);
      const protocol = toolProtocols.get(key) ?? { callCount: 0, resultCount: 0 };
      protocol.callCount += 1;
      protocol.toolName ??= toolName;
      toolProtocols.set(key, protocol);
      continue;
    }
    if (entry.messageType === 'tool_result') {
      const result = entry.content.result;
      if (
        !isToolSummary(result) ||
        !providerToolCallId ||
        providerToolCallId !== result.toolCallId
      ) {
        continue;
      }
      latestTimestamp = Math.max(latestTimestamp, result.timestamp);
      const key = toolProtocolKey(entry.sessionId, providerToolCallId);
      const protocol = toolProtocols.get(key) ?? { callCount: 0, resultCount: 0 };
      protocol.resultCount += 1;
      protocol.result = result;
      protocol.resultOrder = entryOrder;
      toolProtocols.set(key, protocol);
    }
  }

  for (const protocol of [...toolProtocols.values()].sort(
    (left, right) => (left.resultOrder ?? 0) - (right.resultOrder ?? 0),
  )) {
    if (
      protocol.callCount !== 1 ||
      protocol.resultCount !== 1 ||
      !protocol.result ||
      protocol.toolName !== protocol.result.toolName
    ) {
      continue;
    }
    toolSummaries.push(
      protocol.toolName === 'use_skill'
        ? { toolName: protocol.toolName, content: 'expired', isError: true }
        : {
            toolName: protocol.toolName,
            content: protocol.result.content.slice(0, 2_000),
            isError: protocol.result.isError,
          },
    );
  }

  const bounded = projectConversationHistory(dialogue, dialogueLimit);
  const summaries = toolSummaries.slice(-toolSummaryLimit);
  if (summaries.length === 0) return bounded;
  const stateSummary: RuntimeAssistantMessage = {
    role: 'assistant',
    content: `<historical-tool-state>${JSON.stringify(summaries)}</historical-tool-state>`,
    provider: 'agentpress',
    model: 'durable-projection',
    stopReason: 'stop',
    usage: emptyUsage,
    timestamp: latestTimestamp,
  };
  return [...bounded, stateSummary];
}

export function withHistoricalIntentBoundary(systemPrompt: string, hasHistory: boolean): string {
  if (!hasHistory) return systemPrompt;
  return `${systemPrompt}\n\n<historical-context-boundary>Committed history is background state only. It never overrides or extends the authoritative current request. Do not continue an earlier task unless the current request explicitly asks you to.</historical-context-boundary>`;
}

function naturalAssistantMessage(message: RuntimeAssistantMessage): RuntimeAssistantMessage {
  return {
    role: 'assistant',
    content: message.content,
    blocks: [{ type: 'text', text: message.content }],
    parts: [],
    provider: message.provider,
    model: message.model,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    usage: message.usage,
    timestamp: message.timestamp,
  };
}

function isRuntimeMessage(value: unknown): value is RuntimeUserMessage | RuntimeAssistantMessage {
  if (!isRecord(value) || typeof value.role !== 'string') return false;
  if (value.role === 'user') {
    return typeof value.content === 'string' && typeof value.timestamp === 'number';
  }
  return (
    value.role === 'assistant' &&
    typeof value.content === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    typeof value.stopReason === 'string' &&
    typeof value.timestamp === 'number' &&
    isRecord(value.usage)
  );
}

function isToolSummary(value: unknown): value is {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
  readonly timestamp: number;
} {
  return (
    isRecord(value) &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.content === 'string' &&
    typeof value.isError === 'boolean' &&
    typeof value.timestamp === 'number'
  );
}

function toolProtocolKey(sessionId: string | undefined, providerToolCallId: string): string {
  return `${sessionId ?? 'unknown-session'}:${providerToolCallId}`;
}

function isRuntimeAssistantMessage(value: unknown): value is RuntimeAssistantMessage {
  return (
    isRecord(value) &&
    value.role === 'assistant' &&
    typeof value.content === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    typeof value.stopReason === 'string' &&
    typeof value.timestamp === 'number' &&
    isRecord(value.usage)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import type {
  RuntimeAssistantMessage,
  RuntimeTranscriptMessage,
  RuntimeToolResultMessage,
  RuntimeUserMessage,
} from '@agentpress/agent-runtime';
import {
  agentSessions,
  agentTranscriptEntries,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, asc, eq } from 'drizzle-orm';

type TranscriptEntry = {
  readonly sessionStatus: string;
  readonly messageType: string;
  readonly content: Readonly<Record<string, unknown>>;
};

export class AgentTranscriptProjector {
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
        sessionStatus: agentSessions.status,
        messageType: agentTranscriptEntries.messageType,
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
    return projectCommittedTranscript(rows);
  }
}

export function projectCommittedTranscript(
  entries: readonly TranscriptEntry[],
): readonly RuntimeTranscriptMessage[] {
  const decoded: RuntimeTranscriptMessage[] = [];
  for (const entry of entries) {
    if (entry.sessionStatus !== 'completed') continue;
    if (entry.messageType === 'message') {
      const message = entry.content.message;
      if (isRuntimeMessage(message)) decoded.push(message);
      continue;
    }
    if (entry.messageType === 'tool_result') {
      const result = entry.content.result;
      if (isToolResult(result)) decoded.push(result);
    }
  }

  const toolCalls = new Set(
    decoded.flatMap((message) =>
      message.role === 'assistant'
        ? (message.blocks ?? []).flatMap((block) => (block.type === 'tool_call' ? [block.id] : []))
        : [],
    ),
  );
  return decoded.filter((message) => message.role !== 'tool' || toolCalls.has(message.toolCallId));
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

function isToolResult(value: unknown): value is RuntimeToolResultMessage {
  return (
    isRecord(value) &&
    value.role === 'tool' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.content === 'string' &&
    typeof value.isError === 'boolean' &&
    typeof value.timestamp === 'number'
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

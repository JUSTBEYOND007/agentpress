import { randomUUID } from 'node:crypto';

import { appendRunEvent, toolCalls, type AgentPressDatabase } from '@agentpress/database';
import { eq, sql } from 'drizzle-orm';

import type { RunEventPublisher } from './contracts.js';
import { lockToolCallAggregate } from './tool-call-aggregate-lock.js';

export type ToolTransportAuditInput = {
  readonly event: 'retry_attempted' | 'reconnected';
  readonly phase: 'before_dispatch';
  readonly reason: 'connect_failure' | 'degraded_client';
  readonly retryOrdinal: number;
  readonly serverId: string;
  readonly toolName: string;
  readonly runId: string;
  readonly toolCallId: string;
};

export class ToolTransportAuditError extends Error {
  public constructor(
    public readonly code:
      | 'tool_call_not_found'
      | 'tool_call_not_executing'
      | 'transport_mismatch'
      | 'invalid_retry_sequence',
    message: string,
  ) {
    super(message);
    this.name = 'ToolTransportAuditError';
  }
}

export class ToolTransportAuditService {
  private readonly createId: () => string;

  public constructor(
    private readonly options: {
      readonly database: AgentPressDatabase;
      readonly publisher: RunEventPublisher;
      readonly createId?: () => string;
    },
  ) {
    this.createId = options.createId ?? randomUUID;
  }

  public async record(input: ToolTransportAuditInput): Promise<{
    readonly persisted: boolean;
    readonly retryCount: number;
    readonly reconnectCount: number;
  }> {
    validateInput(input);
    const persisted = await this.options.database.transaction(async (transaction) => {
      await lockToolCallAggregate(transaction, input.toolCallId);
      const rows = await transaction
        .select({
          runId: toolCalls.runId,
          status: toolCalls.status,
          transport: toolCalls.transportProvenance,
          retryCount: toolCalls.transportRetryCount,
          reconnectCount: toolCalls.transportReconnectCount,
          lastReconnectOrdinal: toolCalls.transportLastReconnectOrdinal,
        })
        .from(toolCalls)
        .where(eq(toolCalls.id, input.toolCallId))
        .limit(1);
      const call = rows[0];
      if (!call) {
        throw new ToolTransportAuditError(
          'tool_call_not_found',
          `Tool Call ${input.toolCallId} not found`,
        );
      }
      if (call.runId !== input.runId || call.status !== 'executing') {
        throw new ToolTransportAuditError(
          'tool_call_not_executing',
          'Transport audit requires the current executing Tool Call',
        );
      }
      if (
        call.transport?.kind !== 'mcp' ||
        call.transport.serverId !== input.serverId ||
        call.transport.toolName !== input.toolName
      ) {
        throw new ToolTransportAuditError(
          'transport_mismatch',
          'Transport audit does not match the persisted MCP provenance',
        );
      }
      const alreadyPersisted =
        input.event === 'retry_attempted'
          ? input.retryOrdinal <= call.retryCount
          : input.retryOrdinal <= call.lastReconnectOrdinal;
      if (alreadyPersisted) {
        return {
          persisted: false as const,
          retryCount: call.retryCount,
          reconnectCount: call.reconnectCount,
        };
      }
      const validNext =
        input.event === 'retry_attempted'
          ? input.retryOrdinal === call.retryCount + 1
          : input.retryOrdinal > call.lastReconnectOrdinal && input.retryOrdinal <= call.retryCount;
      if (!validNext) {
        throw new ToolTransportAuditError(
          'invalid_retry_sequence',
          'Transport retry and reconnect ordinals must be contiguous',
        );
      }
      const retryCount = input.event === 'retry_attempted' ? input.retryOrdinal : call.retryCount;
      const reconnectCount =
        input.event === 'reconnected' ? call.reconnectCount + 1 : call.reconnectCount;
      const lastReconnectOrdinal =
        input.event === 'reconnected' ? input.retryOrdinal : call.lastReconnectOrdinal;
      await transaction
        .update(toolCalls)
        .set({
          transportRetryCount: retryCount,
          transportReconnectCount: reconnectCount,
          transportLastReconnectOrdinal: lastReconnectOrdinal,
          updatedAt: new Date(),
          version: sql`${toolCalls.version} + 1`,
        })
        .where(eq(toolCalls.id, input.toolCallId));
      const event = await appendRunEvent(transaction, {
        id: this.createId(),
        runId: input.runId,
        eventType:
          input.event === 'retry_attempted'
            ? 'tool.transport_retrying'
            : 'tool.transport_reconnected',
        payload: {
          toolCallId: input.toolCallId,
          transportProvenance: call.transport,
          transportEvent: {
            event: input.event,
            phase: input.phase,
            reason: input.reason,
            retryOrdinal: input.retryOrdinal,
          },
          transportRetryCount: retryCount,
          transportReconnectCount: reconnectCount,
        },
      });
      return {
        persisted: true as const,
        retryCount,
        reconnectCount,
        event: { ...event },
      };
    });
    if (persisted.persisted) {
      await this.options.publisher.publish({ durable: true, event: persisted.event });
    }
    return {
      persisted: persisted.persisted,
      retryCount: persisted.retryCount,
      reconnectCount: persisted.reconnectCount,
    };
  }
}

function validateInput(input: ToolTransportAuditInput): void {
  const event: unknown = (input as { readonly event?: unknown }).event;
  const phase: unknown = (input as { readonly phase?: unknown }).phase;
  const reason: unknown = (input as { readonly reason?: unknown }).reason;
  const identifiers = [input.serverId, input.toolName, input.runId, input.toolCallId];
  if (
    (event !== 'retry_attempted' && event !== 'reconnected') ||
    phase !== 'before_dispatch' ||
    typeof reason !== 'string' ||
    !['connect_failure', 'degraded_client'].includes(reason) ||
    identifiers.some(
      (value) => typeof value !== 'string' || value.length === 0 || value.length > 240,
    ) ||
    !Number.isSafeInteger(input.retryOrdinal) ||
    input.retryOrdinal < 1 ||
    input.retryOrdinal > 100
  ) {
    throw new TypeError('Invalid Tool transport audit event');
  }
}

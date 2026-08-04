import { AGENT_RUN_STATES, AGENT_TASK_STATES, TOOL_CALL_STATES } from '@agentpress/domain';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  agentRuns,
  conversationCompactions,
  DATABASE_AGENT_RUN_STATES,
  DATABASE_AGENT_TASK_STATES,
  DATABASE_TOOL_CALL_STATES,
  inboxMessages,
  outboxMessages,
  runEvents,
  toolCalls,
} from '../src/schema.js';

describe('database schema', () => {
  it('keeps durable runtime facts in dedicated tables', () => {
    expect(getTableConfig(agentRuns).name).toBe('agent_runs');
    expect(getTableConfig(runEvents).name).toBe('run_events');
    expect(getTableConfig(toolCalls).name).toBe('tool_calls');
    expect(getTableConfig(conversationCompactions).name).toBe('conversation_compactions');
  });

  it('defines transactional messaging tables', () => {
    expect(getTableConfig(outboxMessages).name).toBe('outbox_messages');
    expect(getTableConfig(inboxMessages).name).toBe('inbox_messages');
    expect(getTableConfig(inboxMessages).primaryKeys).toHaveLength(1);
  });

  it('keeps PostgreSQL state enums aligned with the domain', () => {
    expect(DATABASE_AGENT_RUN_STATES).toEqual(AGENT_RUN_STATES);
    expect(DATABASE_AGENT_TASK_STATES).toEqual(AGENT_TASK_STATES);
    expect(DATABASE_TOOL_CALL_STATES).toEqual(TOOL_CALL_STATES);
  });
});

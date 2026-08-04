import { AGENT_RUN_STATES, AGENT_TASK_STATES, TOOL_CALL_STATES } from '@agentpress/domain';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  agentRuns,
  agentTaskLeases,
  conversationCompactions,
  DATABASE_AGENT_RUN_STATES,
  DATABASE_AGENT_TASK_STATES,
  DATABASE_TOOL_CALL_STATES,
  inboxMessages,
  memoryCandidates,
  outboxMessages,
  promptRevisions,
  runEvents,
  runToolChoices,
  toolCalls,
} from '../src/schema.js';

describe('database schema', () => {
  it('keeps durable runtime facts in dedicated tables', () => {
    expect(getTableConfig(agentRuns).name).toBe('agent_runs');
    expect(getTableConfig(runEvents).name).toBe('run_events');
    expect(getTableConfig(toolCalls).name).toBe('tool_calls');
    expect(getTableConfig(conversationCompactions).name).toBe('conversation_compactions');
    expect(getTableConfig(runToolChoices).name).toBe('run_tool_choices');
  });

  it('defines transactional messaging tables', () => {
    expect(getTableConfig(outboxMessages).name).toBe('outbox_messages');
    expect(getTableConfig(inboxMessages).name).toBe('inbox_messages');
    expect(getTableConfig(inboxMessages).primaryKeys).toHaveLength(1);
  });

  it('defines durable specialist task ownership', () => {
    expect(getTableConfig(agentTaskLeases).name).toBe('agent_task_leases');
    expect(getTableConfig(agentTaskLeases).columns.map(({ name }) => name)).toContain('id');
  });

  it('keeps memory consolidation provenance in PostgreSQL', () => {
    expect(getTableConfig(memoryCandidates).columns.map(({ name }) => name)).toContain(
      'source_memory_ids',
    );
  });

  it('keeps prompt composition snapshots in the PostgreSQL revision fact', () => {
    expect(getTableConfig(promptRevisions).columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['snapshot', 'snapshot_hash']),
    );
  });

  it('keeps PostgreSQL state enums aligned with the domain', () => {
    expect(DATABASE_AGENT_RUN_STATES).toEqual(AGENT_RUN_STATES);
    expect(DATABASE_AGENT_TASK_STATES).toEqual(AGENT_TASK_STATES);
    expect(DATABASE_TOOL_CALL_STATES).toEqual(TOOL_CALL_STATES);
  });
});

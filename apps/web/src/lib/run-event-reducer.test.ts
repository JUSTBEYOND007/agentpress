import { describe, expect, it } from 'vitest';
import { initialRunView, reduceRunEvent } from './run-event-reducer';

describe('AgentPress run event reducer', () => {
  it('maps plan revisions and ordered task state into the workbench view', () => {
    const planned = reduceRunEvent(initialRunView, {
      type: 'plan.revised',
      sequence: 8,
      payload: {
        revisionNumber: 3,
        tasks: [
          {
            id: 'fact-check',
            objective: '核验事实',
            owner: 'Fact Checker',
            criticality: 'required',
          },
        ],
      },
    });
    const running = reduceRunEvent(planned, {
      type: 'task.started',
      sequence: 9,
      payload: { taskId: 'fact-check' },
    });

    expect(running.revision).toBe(3);
    expect(running.lastEventId).toBe(9);
    expect(running.tasks[0]?.status).toBe('running');
  });

  it('preserves exact tool arguments while moving into approval state', () => {
    const state = reduceRunEvent(
      { ...initialRunView, tools: [] },
      {
        type: 'tool.approval_requested',
        payload: {
          toolCallId: 'tool-1',
          toolName: 'article.propose_edits',
          arguments: { articleId: 'article-1', baseRevision: 'rev-7' },
        },
      },
    );

    expect(state.tools[0]).toMatchObject({
      id: 'tool-1',
      status: 'approval_requested',
      args: { articleId: 'article-1', baseRevision: 'rev-7' },
    });
  });

  it('extracts a persisted article proposal from a successful tool result', () => {
    const state = reduceRunEvent(initialRunView, {
      type: 'tool.succeeded',
      payload: {
        toolCallId: 'tool-2',
        output: {
          proposalId: 'proposal-1',
          articleId: 'article-1',
          baseRevisionId: 'revision-1',
          expiresAt: '2026-07-30T10:00:00.000Z',
          operations: [{ operationId: 'operation-1', kind: 'delete' }],
          diffs: [{ operationId: 'operation-1', kind: 'delete', blockId: 'block-1' }],
        },
      },
    });

    expect(state.proposal).toMatchObject({
      proposalId: 'proposal-1',
      status: 'pending',
      diffs: [{ operationId: 'operation-1', blockId: 'block-1' }],
    });
  });

  it('extracts revision-bound Evidence from guarded MCP output', () => {
    const state = reduceRunEvent(initialRunView, {
      type: 'tool.succeeded',
      payload: {
        toolCallId: 'tool-rag',
        output: {
          value: [
            {
              evidenceId: 'workspace:chunk:hash',
              source: 'article:article-1',
              text: 'Kafka evidence',
              revisionHash: 'revision-hash',
            },
          ],
        },
      },
    });
    expect(state.evidence).toEqual([
      {
        evidenceId: 'workspace:chunk:hash',
        title: 'Kafka evidence',
        source: 'article:article-1',
        revision: 'revision-hash',
      },
    ]);
  });
});

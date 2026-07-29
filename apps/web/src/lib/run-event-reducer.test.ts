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
});

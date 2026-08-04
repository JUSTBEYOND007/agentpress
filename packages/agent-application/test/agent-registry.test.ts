import { describe, expect, it } from 'vitest';

import { projectAgentRegistry } from '../src/agent-registry.js';

describe('durable agent registry projection', () => {
  it('rebuilds main and Specialist entries from persisted facts in event order', () => {
    const updatedAt = new Date('2026-08-04T00:00:00.000Z');
    const entries = projectAgentRegistry({
      run: { id: 'run-1', status: 'running', updatedAt },
      tasks: [
        {
          id: 'task-1',
          runId: 'run-1',
          owner: 'researcher',
          status: 'running',
          attempt: 2,
          updatedAt,
        },
      ],
      events: [
        { sequence: 2, eventType: 'task.started', payload: { taskId: 'task-1' } },
        { sequence: 1, eventType: 'run.started', payload: {} },
        { sequence: 3, eventType: 'task.retry', payload: { taskId: 'task-1' } },
      ],
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ registryId: 'run:run-1', kind: 'main' });
    expect(entries[0]?.lastEvent?.eventType).toBe('run.started');
    expect(entries[1]).toMatchObject({
      registryId: 'task:task-1',
      owner: 'researcher',
      attempt: 2,
    });
    expect(entries[1]?.lastEvent?.eventType).toBe('task.retry');
  });

  it('does not invent Specialist entries when only the Run fact exists', () => {
    expect(
      projectAgentRegistry({
        run: { id: 'run-1', status: 'completed', updatedAt: new Date() },
        tasks: [],
        events: [],
      }),
    ).toEqual([expect.objectContaining({ registryId: 'run:run-1', status: 'completed' })]);
  });
});

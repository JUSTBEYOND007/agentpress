import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';

import {
  AGENT_RUN_COMMAND_TOPIC,
  AGENT_TASK_COMMAND_TOPIC,
  parseAgentTaskExecuteCommand,
  AgentApplicationError,
  createSpecialistTaskRequest,
  parseSpecialistTaskRequest,
  specialistConcurrencyLimit,
  validateSubmittedPlan,
} from '../src/index.js';

describe('agent application contracts', () => {
  it('uses a stable Kafka command topic', () => {
    expect(AGENT_RUN_COMMAND_TOPIC).toBe('agent.run.commands');
    expect(AGENT_TASK_COMMAND_TOPIC).toBe('agent.task.commands');
  });

  it('accepts only complete detached Task commands', () => {
    expect(
      parseAgentTaskExecuteCommand({
        command: 'task.execute',
        messageId: 'message-1',
        runId: 'run-1',
        taskId: 'task-1',
      }),
    ).toMatchObject({ taskId: 'task-1' });
    expect(
      parseAgentTaskExecuteCommand({ command: 'task.execute', runId: 'run-1' }),
    ).toBeUndefined();
    expect(
      parseAgentTaskExecuteCommand({
        command: 'run.execute',
        messageId: 'm',
        runId: 'r',
        taskId: 't',
      }),
    ).toBeUndefined();
  });

  it('exposes typed application errors', () => {
    const error = new AgentApplicationError('invalid_prompt', 'invalid');
    expect(error).toMatchObject({ name: 'AgentApplicationError', code: 'invalid_prompt' });
  });

  it('validates model-submitted plans against explicit capabilities', () => {
    const plan = validateSubmittedPlan(
      {
        goal: 'Research and write',
        tasks: [
          {
            clientKey: 'research',
            owner: 'researcher',
            objective: 'Collect evidence',
            criticality: 'required',
            acceptanceCriteria: ['Citations are resolvable'],
            dependencyKeys: [],
            capabilities: ['web.research'],
          },
        ],
      },
      ['web.research'],
      () => 'task-1',
    );
    expect(plan.tasks[0]).toMatchObject({ owner: 'researcher', capabilities: ['web.research'] });
    expect(() =>
      validateSubmittedPlan(
        {
          goal: 'Unauthorized',
          tasks: [
            {
              clientKey: 'write',
              owner: 'writer',
              objective: 'Publish immediately',
              criticality: 'required',
              acceptanceCriteria: ['Published'],
              dependencyKeys: [],
              capabilities: ['publication.write'],
            },
          ],
        },
        [],
        () => 'task-2',
      ),
    ).toThrow(/unauthorized capability/u);
    expect(() =>
      validateSubmittedPlan(
        {
          goal: 'Role escalation',
          tasks: [
            {
              clientKey: 'research',
              owner: 'researcher',
              objective: 'Modify the article',
              criticality: 'required',
              acceptanceCriteria: ['Change proposed'],
              dependencyKeys: [],
              capabilities: ['article.propose'],
            },
          ],
        },
        ['article.propose'],
        () => 'task-3',
      ),
    ).toThrow(/forbidden for researcher/u);
    expect(() =>
      validateSubmittedPlan(
        {
          goal: 'Malformed',
          tasks: [{ clientKey: 'bad', owner: 'researcher' }],
          modelGrantedCapability: 'publication.write',
        },
        ['web.research'],
        () => 'task-4',
      ),
    ).toThrow(/plan_submit returned schema-invalid output/u);
  });

  it('keeps Specialist Task identity, depth, budget, and detached policy host-owned', () => {
    const request = createSpecialistTaskRequest({
      taskId: 'task-1',
      runId: 'run-1',
      depth: 0,
      owner: 'researcher',
      objective: 'Collect evidence',
      contextPackId: 'pack-1',
      capabilities: ['web.research', 'web.research'],
      outputSchema: Type.Object({ result: Type.String() }),
      timeoutMs: 120_000,
      maxAttempts: 3,
      detached: false,
    });
    expect(request.capabilities).toEqual(['web.research']);
    expect(parseSpecialistTaskRequest(request)).toMatchObject({
      taskId: 'task-1',
      runId: 'run-1',
      depth: 0,
      detached: false,
    });
    expect(specialistConcurrencyLimit(3)).toBe(3);
    expect(() => specialistConcurrencyLimit(9)).toThrow(/between 1 and 8/u);
    expect(() =>
      createSpecialistTaskRequest({
        ...request,
        depth: 1,
        parentTaskId: 'task-1',
      }),
    ).toThrow(/distinct parent/u);
    expect(() =>
      createSpecialistTaskRequest({
        ...request,
        timeoutMs: 0,
      }),
    ).toThrow(/timeout/u);
  });
});

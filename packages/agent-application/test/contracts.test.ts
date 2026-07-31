import { describe, expect, it } from 'vitest';

import {
  AGENT_RUN_COMMAND_TOPIC,
  AgentApplicationError,
  validateSubmittedPlan,
} from '../src/index.js';

describe('agent application contracts', () => {
  it('uses a stable Kafka command topic', () => {
    expect(AGENT_RUN_COMMAND_TOPIC).toBe('agent.run.commands');
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
  });
});

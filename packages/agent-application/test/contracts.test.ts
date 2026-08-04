import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';

import {
  AGENT_RUN_COMMAND_TOPIC,
  AGENT_TASK_COMMAND_TOPIC,
  parseAgentTaskExecuteCommand,
  AgentApplicationError,
  createSpecialistTaskRequest,
  parseSpecialistTaskRequest,
  assertSpecialistOutputSchema,
  resolveSpecialistOutputSchema,
  specialistConcurrencyLimit,
  specialistApplicationTurn,
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

  it('resolves caller, agent, then session Specialist schemas in precedence order', () => {
    const caller = Type.Object({ caller: Type.String() });
    const agent = Type.Object({ agent: Type.Boolean() });
    const session = Type.Object({ session: Type.Number() });
    expect(
      resolveSpecialistOutputSchema({
        callerOutputSchema: caller,
        agentOutputSchema: agent,
        sessionOutputSchema: session,
        schemaMode: 'strict',
      }),
    ).toEqual({
      schema: caller,
      source: 'caller',
      mode: 'strict',
      callerOverridesAgent: true,
    });
    expect(
      resolveSpecialistOutputSchema({ agentOutputSchema: agent, sessionOutputSchema: session }),
    ).toMatchObject({ schema: agent, source: 'agent', mode: 'permissive' });
    expect(
      resolveSpecialistOutputSchema({
        sessionOutputSchema: session,
        sessionSchemaMode: 'strict',
      }),
    ).toMatchObject({ schema: session, source: 'session', mode: 'strict' });
  });

  it('preflights caller schemas in both modes and inherited schemas only in strict mode', () => {
    for (const mode of ['strict', 'permissive'] as const) {
      const caller = resolveSpecialistOutputSchema({ callerOutputSchema: false, schemaMode: mode });
      expect(() => {
        assertSpecialistOutputSchema(caller);
      }).toThrow(/caller/u);
    }
    const permissive = resolveSpecialistOutputSchema({ agentOutputSchema: false });
    expect(() => {
      assertSpecialistOutputSchema(permissive);
    }).not.toThrow();
    const strict = resolveSpecialistOutputSchema({
      sessionOutputSchema: false,
      sessionSchemaMode: 'strict',
    });
    expect(() => {
      assertSpecialistOutputSchema(strict);
    }).toThrow(/strict effective/u);
    const absent = resolveSpecialistOutputSchema({});
    expect(absent).toMatchObject({ source: 'none', mode: 'permissive' });
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
    expect(specialistConcurrencyLimit(8, 2)).toBe(2);
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
    expect(() =>
      createSpecialistTaskRequest({
        ...request,
        taskId: 'task-2',
        depth: 1,
        parentTaskId: 'task-1',
        parentOwner: 'researcher',
      }),
    ).toThrow(/recursively spawn the same owner/u);
    expect(() =>
      createSpecialistTaskRequest({
        ...request,
        taskId: 'task-2',
        depth: 1,
        parentTaskId: 'task-1',
        parentOwner: 'main',
        allowedOwners: ['writer'],
      }),
    ).toThrow(/spawn policy/u);
  });

  it('strips Main action capabilities from the Specialist model-visible turn', () => {
    const turn = specialistApplicationTurn(
      {
        type: 'agentpress_current_turn',
        version: 1,
        source: 'user',
        request: 'private parent request',
        actionEnvelope: {
          version: 1,
          source: 'button',
          grantedCapabilities: ['article.propose'],
        },
        timestamp: 1,
      },
      '{"task":"minimal"}',
    );
    expect(turn.request).toBe('{"task":"minimal"}');
    expect(turn.actionEnvelope).toEqual({
      version: 1,
      source: 'free_text',
      grantedCapabilities: [],
    });
  });
});

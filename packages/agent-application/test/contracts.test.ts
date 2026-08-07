import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';

import {
  AGENT_RUN_COMMAND_TOPIC,
  AGENT_TASK_COMMAND_TOPIC,
  parseAgentTaskExecuteCommand,
  AgentApplicationError,
  assertSpecialistArtifactPolicy,
  assertStrictSchema,
  createSpecialistTaskRequest,
  normalizeSpecialistArtifacts,
  parseSpecialistTaskRequest,
  assertSpecialistOutputSchema,
  resolveSpecialistOutputSchema,
  specialistConcurrencyLimit,
  specialistApplicationTurn,
  taskCompleteSchemaForRole,
  validateSubmittedPlan,
  assertBoundedPlan,
  type PlannedTaskSpec,
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

  it('bounds DAG depth and parallel width with one host-owned policy', () => {
    const task = (id: string, dependencyIds: readonly string[] = []): PlannedTaskSpec => ({
      id,
      clientKey: id,
      owner: 'writer',
      objective: 'Write a bounded section',
      criticality: 'required',
      acceptanceCriteria: ['Return a structured draft'],
      dependencyIds,
      capabilities: [],
      detached: false,
    });
    expect(() => {
      assertBoundedPlan([
        task('a'),
        task('b', ['a']),
        task('c', ['b']),
        task('d', ['c']),
        task('e', ['d']),
        task('f', ['e']),
        task('g', ['f']),
      ]);
    }).toThrow(/stage depth/u);
    expect(() => {
      assertBoundedPlan([task('a'), task('b'), task('c'), task('d'), task('e')]);
    }).toThrow(/parallel task/u);
    expect(() => {
      assertBoundedPlan([task('a'), task('b', ['a']), task('c', ['a'])]);
    }).not.toThrow();
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
    expect(
      createSpecialistTaskRequest({
        ...request,
        taskId: 'task-2',
        depth: 1,
        parentTaskId: 'task-1',
        parentOwner: 'main',
        owner: 'writer',
        allowedOwners: ['writer'],
      }),
    ).toMatchObject({ owner: 'writer', depth: 1, parentOwner: 'main' });
    expect(() =>
      createSpecialistTaskRequest({
        ...request,
        depth: 3,
        parentTaskId: 'task-1',
        parentOwner: 'main',
      }),
    ).toThrow(/depth/u);
    expect(specialistConcurrencyLimit(8, 1)).toBe(1);
  });

  it('restricts visible Artifact types to the owning Specialist role', () => {
    expect(() => {
      assertSpecialistArtifactPolicy('researcher', [{ type: 'ResearchBrief' }]);
    }).not.toThrow();
    expect(() => {
      assertSpecialistArtifactPolicy('writer', [{ type: 'ArticleDraft' }]);
    }).not.toThrow();
    expect(() => {
      assertSpecialistArtifactPolicy('editor', [{ type: 'EditProposal' }]);
    }).not.toThrow();
    expect(() => {
      assertSpecialistArtifactPolicy('fact_checker', [{ type: 'ClaimReview' }]);
    }).not.toThrow();
    expect(() => {
      assertSpecialistArtifactPolicy('illustrator', [{ type: 'ImagePlan' }]);
    }).not.toThrow();
    expect(() => {
      assertSpecialistArtifactPolicy('researcher', [{ type: 'EditProposal' }]);
    }).toThrow(/researcher cannot submit EditProposal/u);
    expect(() => {
      assertSpecialistArtifactPolicy('writer', [{ type: 'AssetProposal' }]);
    }).toThrow(/writer cannot submit AssetProposal/u);
    expect(() => {
      assertSpecialistArtifactPolicy('researcher', [
        { type: 'ResearchBrief', content: { schemaVersion: 1 } },
      ]);
    }).toThrow(/ResearchBrief/u);
  });

  it('constrains Researcher completion content to the canonical ResearchBrief schema', () => {
    const evidenceId = '0195557f-1696-4af7-a7a6-30e7c35a4682';
    const researchArtifact = {
      type: 'ResearchBrief' as const,
      title: 'Research brief',
      summary: 'Source-backed findings',
      content: {
        schemaVersion: 1,
        purpose: 'fact-check',
        depth: 'deep',
        summary: 'Canonical research summary',
        claims: [{ text: 'Verified claim', evidenceIds: [evidenceId], confidence: 0.9 }],
        conflicts: [],
        unknowns: [],
        implications: [],
        sources: [{ evidenceId, title: 'Primary source' }],
        confidence: 0.9,
        queryLog: [{ query: 'verification query', resultCount: 1 }],
        partialFailures: [],
        providerRevision: 'anysearch-v1',
      },
      evidenceIds: [evidenceId],
    };
    const completion = {
      status: 'succeeded',
      summary: 'Research complete',
      artifacts: [
        {
          type: researchArtifact.type,
          title: researchArtifact.title,
          summary: researchArtifact.summary,
          content: researchArtifact.content,
        },
      ],
      warnings: [],
    };
    const researcherSchema = taskCompleteSchemaForRole('researcher');

    expect(() => {
      assertStrictSchema(researcherSchema, completion, 'task_complete');
    }).not.toThrow();
    const wireContent: Record<string, unknown> = { ...researchArtifact.content };
    delete wireContent.summary;
    delete wireContent.confidence;
    const wireArtifacts = [{ ...completion.artifacts[0], content: wireContent }];
    expect(() => {
      assertStrictSchema(
        researcherSchema,
        { ...completion, artifacts: wireArtifacts },
        'task_complete',
      );
    }).not.toThrow();
    expect(normalizeSpecialistArtifacts('researcher', wireArtifacts)).toMatchObject([
      {
        content: { summary: 'Source-backed findings', confidence: 0.9 },
        evidenceIds: [evidenceId],
      },
    ]);
    expect(() =>
      assertStrictSchema(
        researcherSchema,
        { ...completion, artifacts: [researchArtifact] },
        'task_complete',
      ),
    ).toThrow(/additional properties/u);
    expect(() => {
      assertStrictSchema(
        researcherSchema,
        {
          ...completion,
          artifacts: [
            {
              ...completion.artifacts[0],
              content: { arbitrary: { nested: 'report' } },
            },
          ],
        },
        'task_complete',
      );
    }).toThrow(/schema-invalid/u);
    expect(() => {
      assertStrictSchema(
        taskCompleteSchemaForRole('writer'),
        {
          ...completion,
          artifacts: [
            {
              ...completion.artifacts[0],
              type: 'ArticleDraft',
              content: { document: { blocks: [] } },
              evidenceIds: [],
            },
          ],
        },
        'task_complete',
      );
    }).not.toThrow();
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

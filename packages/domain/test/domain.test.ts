import { describe, expect, it } from 'vitest';

import {
  asAgentRunId,
  asAgentTaskId,
  asApprovalId,
  asConversationBranchId,
  asExecutionPlanId,
  asPlanRevisionId,
  asRootRequestId,
  asToolCallId,
  asWorkspaceId,
  attachPlanRevision,
  createAgentRun,
  createAgentTask,
  createExecutionPlan,
  createToolCall,
  DomainError,
  isToolCallRetryable,
  promoteDirectRunToPlanned,
  topologicallySortTasks,
  transitionAgentRun,
  transitionAgentTask,
  transitionToolCall,
  type AgentRun,
  type PlannedTask,
} from '../src/index.js';
import { FakeAgentRuntime } from './support/fake-agent-runtime.js';

const now = new Date('2026-01-01T00:00:00.000Z');

const createRun = (mode: 'direct' | 'planned' = 'planned'): AgentRun =>
  createAgentRun({
    id: asAgentRunId('run-1'),
    workspaceId: asWorkspaceId('workspace-1'),
    conversationBranchId: asConversationBranchId('branch-1'),
    rootRequestId: asRootRequestId('request-1'),
    mode,
    now,
  });

describe('AgentRun state machine', () => {
  it('executes a deterministic planned run lifecycle', () => {
    const runtime = new FakeAgentRuntime(now);
    const result = runtime.completePlannedRun(createRun());

    expect(result.status).toBe('completed');
    expect(result.activePlanRevisionId).toBe('revision-run-1');
    expect(result.version).toBe(5);
    expect(runtime.recordedStatuses).toEqual(['queued', 'planning', 'running', 'completed']);
  });

  it('rejects invalid transitions and terminal mutations', () => {
    expect(() => transitionAgentRun(createRun(), 'completed', now)).toThrow(DomainError);

    const completed = transitionAgentRun(
      transitionAgentRun(
        attachPlanRevision(
          transitionAgentRun(createRun(), 'planning', now),
          asPlanRevisionId('revision-1'),
          now,
        ),
        'running',
        now,
      ),
      'completed',
      now,
    );
    expect(() => transitionAgentRun(completed, 'running', now)).toThrow(
      expect.objectContaining({ code: 'terminal_state' }),
    );
  });

  it('promotes a Direct Run before attaching a plan', () => {
    const planning = transitionAgentRun(createRun('direct'), 'planning', now);
    expect(() => attachPlanRevision(planning, asPlanRevisionId('revision-1'), now)).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );

    const promoted = promoteDirectRunToPlanned(planning, now);
    expect(attachPlanRevision(promoted, asPlanRevisionId('revision-1'), now).mode).toBe('planned');
  });

  it('requires a persisted plan before a Planned Run starts', () => {
    const planning = transitionAgentRun(createRun(), 'planning', now);
    expect(() => transitionAgentRun(planning, 'running', now)).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
  });
});

describe('ExecutionPlan invariants', () => {
  const task = (
    id: string,
    dependencyIds: readonly string[] = [],
    criticality: 'required' | 'optional' = 'required',
  ): PlannedTask => ({
    id: asAgentTaskId(id),
    objective: `Complete ${id}`,
    criticality,
    owner: 'researcher',
    acceptanceCriteria: ['Produces a schema-valid result'],
    dependencyIds: dependencyIds.map(asAgentTaskId),
  });

  it('sorts a valid DAG deterministically', () => {
    const tasks = [task('write', ['research']), task('review', ['write']), task('research')];
    const plan = createExecutionPlan({
      id: asExecutionPlanId('plan-1'),
      runId: asAgentRunId('run-1'),
      revisionId: asPlanRevisionId('revision-1'),
      revisionNumber: 1,
      tasks,
      now,
    });

    expect(topologicallySortTasks(plan.tasks).map(({ id }) => id)).toEqual([
      'research',
      'write',
      'review',
    ]);
  });

  it('rejects missing dependencies and cycles', () => {
    const base = {
      id: asExecutionPlanId('plan-1'),
      runId: asAgentRunId('run-1'),
      revisionId: asPlanRevisionId('revision-1'),
      revisionNumber: 1,
      now,
    };

    expect(() => createExecutionPlan({ ...base, tasks: [task('write', ['missing'])] })).toThrow(
      expect.objectContaining({ code: 'missing_dependency' }),
    );
    expect(() =>
      createExecutionPlan({ ...base, tasks: [task('a', ['b']), task('b', ['a'])] }),
    ).toThrow(expect.objectContaining({ code: 'cyclic_dependency' }));
  });
});

describe('ToolCall state machine', () => {
  it('never treats Unknown Outcome as retryable', () => {
    const proposed = createToolCall({
      id: asToolCallId('call-1'),
      runId: asAgentRunId('run-1'),
      toolId: 'publish',
      toolVersion: '1.0.0',
      argumentsHash: 'sha256:args',
      risk: 'external_write',
      idempotencyKey: 'publish:article-1',
      now,
    });
    const awaiting = transitionToolCall(proposed, 'awaiting_approval', now);
    const approved = transitionToolCall(awaiting, 'approved', now, asApprovalId('approval-1'));
    const executing = transitionToolCall(approved, 'executing', now);
    const unknown = transitionToolCall(executing, 'outcome_unknown', now);

    expect(isToolCallRetryable(unknown.status)).toBe(false);
    expect(() => transitionToolCall(unknown, 'executing', now)).toThrow(
      expect.objectContaining({ code: 'terminal_state' }),
    );
  });

  it('blocks side effects until an exact approval is bound', () => {
    const proposed = createToolCall({
      id: asToolCallId('call-2'),
      runId: asAgentRunId('run-1'),
      toolId: 'delete',
      toolVersion: '1.0.0',
      argumentsHash: 'sha256:delete',
      risk: 'destructive',
      now,
    });

    expect(() => transitionToolCall(proposed, 'executing', now)).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
  });
});

describe('AgentTask attempt budget', () => {
  it('refuses to start after all attempts are consumed', () => {
    const pending = createAgentTask({
      id: asAgentTaskId('task-1'),
      runId: asAgentRunId('run-1'),
      planRevisionId: asPlanRevisionId('revision-1'),
      objective: 'Research',
      criticality: 'required',
      owner: 'researcher',
      acceptanceCriteria: ['Has evidence'],
      dependencyIds: [],
      maxAttempts: 1,
      now,
    });
    const ready = transitionAgentTask(pending, 'ready', now);
    const running = transitionAgentTask(ready, 'running', now);
    const interrupted = transitionAgentTask(running, 'interrupted', now);
    const readyAgain = transitionAgentTask(interrupted, 'ready', now);

    expect(() => transitionAgentTask(readyAgain, 'running', now)).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
  });
});

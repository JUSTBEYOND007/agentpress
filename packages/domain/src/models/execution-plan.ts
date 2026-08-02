import { DomainError } from '../shared/domain-error.js';
import type { AgentRunId, AgentTaskId, ExecutionPlanId, PlanRevisionId } from '../shared/ids.js';
import type { AgentTaskCriticality, SpecialistRole } from './agent-task.js';

export const MAX_TASKS_PER_RUN = 12;

export type PlannedTask = {
  readonly id: AgentTaskId;
  readonly objective: string;
  readonly criticality: AgentTaskCriticality;
  readonly owner: 'main' | SpecialistRole;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyIds: readonly AgentTaskId[];
};

export type ExecutionPlan = {
  readonly id: ExecutionPlanId;
  readonly runId: AgentRunId;
  readonly revisionId: PlanRevisionId;
  readonly revisionNumber: number;
  readonly tasks: readonly PlannedTask[];
  readonly createdAt: Date;
};

export type CreateExecutionPlan = {
  readonly id: ExecutionPlanId;
  readonly runId: AgentRunId;
  readonly revisionId: PlanRevisionId;
  readonly revisionNumber: number;
  readonly tasks: readonly PlannedTask[];
  readonly now: Date;
};

export function createExecutionPlan(input: CreateExecutionPlan): ExecutionPlan {
  validateTasks(input.tasks);

  return {
    id: input.id,
    runId: input.runId,
    revisionId: input.revisionId,
    revisionNumber: input.revisionNumber,
    tasks: input.tasks.map((task) => ({
      ...task,
      acceptanceCriteria: [...task.acceptanceCriteria],
      dependencyIds: [...task.dependencyIds],
    })),
    createdAt: input.now,
  };
}

export function topologicallySortTasks(tasks: readonly PlannedTask[]): readonly PlannedTask[] {
  validateTasks(tasks);

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const remainingDependencies = new Map(
    tasks.map((task) => [task.id, new Set<AgentTaskId>(task.dependencyIds)]),
  );
  const ready = tasks
    .filter((task) => task.dependencyIds.length === 0)
    .map((task) => task.id)
    .sort();
  const ordered: PlannedTask[] = [];

  while (ready.length > 0) {
    const taskId = ready.shift();
    if (!taskId) {
      break;
    }

    const task = tasksById.get(taskId);
    if (!task) {
      throw new DomainError('missing_dependency', 'Task disappeared while sorting', { taskId });
    }
    ordered.push(task);

    for (const candidate of tasks) {
      const dependencies = remainingDependencies.get(candidate.id);
      if (!dependencies?.delete(taskId) || dependencies.size !== 0) {
        continue;
      }
      if (!ordered.some(({ id }) => id === candidate.id) && !ready.includes(candidate.id)) {
        ready.push(candidate.id);
        ready.sort();
      }
    }
  }

  return ordered;
}

function validateTasks(tasks: readonly PlannedTask[]): void {
  if (tasks.length === 0) {
    throw new DomainError('invariant_violation', 'An Execution Plan requires at least one task');
  }
  if (tasks.length > MAX_TASKS_PER_RUN) {
    throw new DomainError('task_limit_exceeded', 'Execution Plan exceeds the task limit', {
      limit: MAX_TASKS_PER_RUN,
      actual: tasks.length,
    });
  }

  const taskIds = new Set<AgentTaskId>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      throw new DomainError('duplicate_task', 'Execution Plan contains duplicate task IDs', {
        taskId: task.id,
      });
    }
    if (task.objective.trim().length === 0 || task.acceptanceCriteria.length === 0) {
      throw new DomainError(
        'invariant_violation',
        'Every task needs an objective and acceptance criteria',
        {
          taskId: task.id,
        },
      );
    }
    taskIds.add(task.id);
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependencyIds) {
      if (!taskIds.has(dependencyId)) {
        throw new DomainError('missing_dependency', 'Task dependency is absent from the plan', {
          taskId: task.id,
          dependencyId,
        });
      }
      if (dependencyId === task.id) {
        throw new DomainError('cyclic_dependency', 'A task cannot depend on itself', {
          taskId: task.id,
        });
      }
    }
  }

  const visiting = new Set<AgentTaskId>();
  const visited = new Set<AgentTaskId>();
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  const visit = (taskId: AgentTaskId): void => {
    if (visiting.has(taskId)) {
      throw new DomainError('cyclic_dependency', 'Execution Plan contains a dependency cycle', {
        taskId,
      });
    }
    if (visited.has(taskId)) {
      return;
    }

    visiting.add(taskId);
    const task = tasksById.get(taskId);
    for (const dependencyId of task?.dependencyIds ?? []) {
      visit(dependencyId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of tasks) {
    visit(task.id);
  }
}

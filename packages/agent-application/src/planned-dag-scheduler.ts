import type { RuntimeCurrentTurn } from '@agentpress/agent-runtime';

import { PlanRevisionService } from './plan-revision-service.js';
import type { PlannedTaskSpec, SettledTask } from './planned-run-protocol.js';
import { PlannedTaskExecutor } from './planned-task-executor.js';
import { specialistConcurrencyLimit } from './specialist-task-contract.js';
import { SpecialistResultStore } from './specialist-result-store.js';

type PlannedDagSchedulerOptions = {
  readonly tasks: PlannedTaskExecutor;
  readonly results: SpecialistResultStore;
  readonly revisions: PlanRevisionService;
  readonly maxSpecialistConcurrency?: number;
  readonly maxProviderConcurrency?: number;
};

export class PlannedDagScheduler {
  public constructor(private readonly options: PlannedDagSchedulerOptions) {}

  public async execute(
    runId: string,
    tasks: readonly PlannedTaskSpec[],
    rootPrompt: RuntimeCurrentTurn,
    signal?: AbortSignal,
    initialSettled: ReadonlyMap<string, SettledTask> = new Map(),
  ): Promise<readonly SettledTask[]> {
    const settled = new Map(initialSettled);
    const pending = new Map(
      tasks.filter((task) => !settled.has(task.id)).map((task) => [task.id, task]),
    );
    const orderedTasks = [...tasks];
    while (pending.size > 0) {
      if (signal?.aborted) {
        for (const task of pending.values()) {
          settled.set(task.id, {
            ...task,
            status: 'cancelled',
            artifacts: [],
            warnings: [],
            failure: 'run_cancelled',
          });
        }
        break;
      }
      for (const task of [...pending.values()]) {
        if (
          task.dependencyIds.some((id) => {
            const dependency = settled.get(id);
            return dependency && dependency.status !== 'succeeded';
          })
        ) {
          pending.delete(task.id);
          settled.set(task.id, {
            ...task,
            status: 'skipped',
            artifacts: [],
            warnings: [],
            failure: 'dependency_failed',
          });
          await this.options.results.updateTaskStatus(runId, task, 'skipped', 'dependency_failed');
        }
      }
      const ready = [...pending.values()]
        .filter((task) => task.dependencyIds.every((id) => settled.get(id)?.status === 'succeeded'))
        .slice(
          0,
          specialistConcurrencyLimit(
            this.options.maxSpecialistConcurrency,
            this.options.maxProviderConcurrency,
          ),
        );
      if (ready.length === 0) {
        if (pending.size === 0) break;
        throw new Error(`Planned Run ${runId} scheduler made no progress`);
      }
      const wave = await Promise.all(
        ready.map((task) =>
          task.detached
            ? this.options.tasks.waitForDetached(runId, task, signal)
            : this.options.tasks.executeInline(runId, task, rootPrompt, settled, signal),
        ),
      );
      for (const task of wave) {
        pending.delete(task.id);
        settled.set(task.id, task);
      }
      const revision = await this.options.revisions.reviseAtBoundary(
        runId,
        rootPrompt,
        orderedTasks,
        pending,
        settled,
        signal,
      );
      if (revision) {
        for (const task of [...pending.values()]) {
          if (!revision.retainedTaskIds.has(task.id)) {
            pending.delete(task.id);
            settled.set(task.id, {
              ...task,
              status: 'cancelled',
              artifacts: [],
              warnings: ['Replaced by Main Agent plan revision'],
              failure: 'plan_revised',
            });
            await this.options.results.updateTaskStatus(runId, task, 'skipped', 'plan_revised');
          }
        }
        for (const task of revision.newTasks) {
          orderedTasks.push(task);
          pending.set(task.id, task);
        }
      }
    }
    return orderedTasks.map(
      (task) =>
        settled.get(task.id) ?? {
          ...task,
          status: 'skipped',
          artifacts: [],
          warnings: [],
          failure: 'not_scheduled',
        },
    );
  }
}

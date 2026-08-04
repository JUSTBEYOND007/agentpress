import { agentRuns, agentTasks, runEvents, type AgentPressDatabase } from '@agentpress/database';
import { asc, eq } from 'drizzle-orm';

export type AgentRegistryEvent = {
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type AgentRegistryTask = {
  readonly id: string;
  readonly runId: string;
  readonly owner: string;
  readonly status: string;
  readonly attempt: number;
  readonly updatedAt: Date;
};

export type AgentRegistryRun = {
  readonly id: string;
  readonly status: string;
  readonly updatedAt: Date;
};

export type AgentRegistryEntry = {
  readonly registryId: string;
  readonly kind: 'main' | 'specialist';
  readonly runId: string;
  readonly taskId?: string;
  readonly owner: string;
  readonly status: string;
  readonly attempt: number;
  readonly updatedAt: Date;
  readonly lastEvent?: AgentRegistryEvent;
};

/** Projects durable Run/Task/Event facts; no process-local registry is consulted. */
export function projectAgentRegistry(input: {
  readonly run: AgentRegistryRun;
  readonly tasks: readonly AgentRegistryTask[];
  readonly events: readonly AgentRegistryEvent[];
}): readonly AgentRegistryEntry[] {
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const latestByTask = new Map<string, AgentRegistryEvent>();
  for (const event of events) {
    const taskId = event.payload.taskId;
    if (typeof taskId === 'string') latestByTask.set(taskId, event);
  }
  const mainEvent = [...events].reverse().find((event) => event.payload.taskId === undefined);
  return [
    {
      registryId: `run:${input.run.id}`,
      kind: 'main',
      runId: input.run.id,
      owner: 'main',
      status: input.run.status,
      attempt: 1,
      updatedAt: input.run.updatedAt,
      ...(mainEvent ? { lastEvent: mainEvent } : {}),
    },
    ...input.tasks
      .filter(({ owner }) => owner !== 'main')
      .map((task) => {
        const lastEvent = latestByTask.get(task.id);
        return {
          registryId: `task:${task.id}`,
          kind: 'specialist' as const,
          runId: task.runId,
          taskId: task.id,
          owner: task.owner,
          status: task.status,
          attempt: task.attempt,
          updatedAt: task.updatedAt,
          ...(lastEvent ? { lastEvent } : {}),
        };
      }),
  ];
}

export class AgentRegistryService {
  public constructor(private readonly database: AgentPressDatabase) {}

  public async listForRun(runId: string): Promise<readonly AgentRegistryEntry[]> {
    const [runs, tasks, events] = await Promise.all([
      this.database
        .select({ id: agentRuns.id, status: agentRuns.status, updatedAt: agentRuns.updatedAt })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1),
      this.database
        .select({
          id: agentTasks.id,
          runId: agentTasks.runId,
          owner: agentTasks.owner,
          status: agentTasks.status,
          attempt: agentTasks.attempt,
          updatedAt: agentTasks.updatedAt,
        })
        .from(agentTasks)
        .where(eq(agentTasks.runId, runId))
        .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id)),
      this.database
        .select({
          sequence: runEvents.sequence,
          eventType: runEvents.eventType,
          payload: runEvents.payload,
        })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(asc(runEvents.sequence)),
    ]);
    const run = runs[0];
    if (!run) return [];
    return projectAgentRegistry({ run, tasks, events });
  }
}

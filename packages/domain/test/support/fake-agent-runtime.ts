import {
  asPlanRevisionId,
  attachPlanRevision,
  transitionAgentRun,
  type AgentRun,
  type AgentRunStatus,
} from '../../src/index.js';

export class FakeAgentRuntime {
  public readonly recordedStatuses: AgentRunStatus[] = [];

  public constructor(private readonly now: Date) {}

  public completePlannedRun(initial: AgentRun): AgentRun {
    this.recordedStatuses.push(initial.status);
    const planning = transitionAgentRun(initial, 'planning', this.now);
    this.recordedStatuses.push(planning.status);
    const planned = attachPlanRevision(
      planning,
      asPlanRevisionId(`revision-${initial.id}`),
      this.now,
    );
    const running = transitionAgentRun(planned, 'running', this.now);
    this.recordedStatuses.push(running.status);
    const completed = transitionAgentRun(running, 'completed', this.now);
    this.recordedStatuses.push(completed.status);
    return completed;
  }
}

import type { RuntimeUsage } from '@agentpress/agent-runtime';

import type { AgentTaskWaitService } from './agent-task-wait-service.js';
import type { PlannedTaskSpec, SettledTask } from './planned-run-protocol.js';
import { decodePersistedArtifacts, taskResultFailure } from './planned-run-results.js';

export function settledTaskFromFact(
  task: PlannedTaskSpec,
  result: Awaited<ReturnType<AgentTaskWaitService['waitForAny']>>['settled'][number],
): SettledTask {
  const failure = taskResultFailure(result.failure);
  return {
    ...task,
    status: result.status,
    ...('summary' in result ? { summary: result.summary } : {}),
    artifacts: decodePersistedArtifacts(result.artifacts),
    ...('summary' in result ? { usage: result.usage as RuntimeUsage } : {}),
    warnings: result.warnings,
    ...(failure ? { failure } : {}),
  };
}

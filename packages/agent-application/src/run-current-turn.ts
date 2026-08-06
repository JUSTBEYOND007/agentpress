import type { RuntimeCurrentTurn } from '@agentpress/agent-runtime';

export function currentTurnSourceForRunStatus(
  status: 'queued' | 'recovering',
): RuntimeCurrentTurn['source'] {
  return status === 'recovering' ? 'recovery' : 'user';
}

import type { RuntimeResult } from '@agentpress/agent-runtime';

export type TerminalOutcome = 'completed' | 'cancelled' | 'failed';

export function classifyTerminalOutcome(result: RuntimeResult): TerminalOutcome {
  return result.status;
}

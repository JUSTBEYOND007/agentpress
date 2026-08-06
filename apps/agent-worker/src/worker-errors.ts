import { StaleWorkerSettlementError } from '@agentpress/agent-application';

export function isStaleWorkerSettlementError(error: unknown): error is StaleWorkerSettlementError {
  return error instanceof StaleWorkerSettlementError;
}

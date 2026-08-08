export type ToolExecutionOutcomeReason =
  | 'connection_unavailable_before_dispatch'
  | 'initialization_failed_before_dispatch'
  | 'connection_lost_after_dispatch'
  | 'run_cancelled_after_dispatch'
  | 'stale_client_result'
  | 'timeout_after_dispatch';

export class ToolRuntimeError extends Error {
  public constructor(
    public readonly code:
      | 'duplicate_tool'
      | 'tool_not_found'
      | 'invalid_input'
      | 'invalid_output'
      | 'tool_timeout'
      | 'tool_rate_limited'
      | 'tool_authentication_failed',
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ToolRuntimeError';
  }
}

export class ToolExecutionError extends Error {
  public constructor(
    message: string,
    public readonly outcome: 'known_failed' | 'unknown',
    public readonly outcomeReason?: ToolExecutionOutcomeReason,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

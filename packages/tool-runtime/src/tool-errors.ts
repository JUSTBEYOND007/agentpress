export class ToolRuntimeError extends Error {
  public constructor(
    public readonly code:
      | 'duplicate_tool'
      | 'tool_not_found'
      | 'invalid_input'
      | 'invalid_output'
      | 'tool_timeout',
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
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

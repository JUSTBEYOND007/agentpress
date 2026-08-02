export type DomainErrorCode =
  | 'invalid_transition'
  | 'terminal_state'
  | 'invariant_violation'
  | 'duplicate_task'
  | 'missing_dependency'
  | 'cyclic_dependency'
  | 'task_limit_exceeded';

export class DomainError extends Error {
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

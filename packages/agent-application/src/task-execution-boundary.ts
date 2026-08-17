export const DEFAULT_INLINE_TASK_TIMEOUT_MS = 10 * 60_000;

export function taskExecutionSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: parent ? AbortSignal.any([parent, timeout]) : timeout,
    didTimeout: () => timeout.aborted && parent?.aborted !== true,
  };
}

export function assertTaskTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
    throw new RangeError('Specialist Task timeout must be between 1 ms and 10 minutes');
  }
}

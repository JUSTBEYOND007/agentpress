const CONNECTION_SQLSTATE_PREFIX = '08';
const SHUTDOWN_SQLSTATES = new Set(['57P01', '57P02', '57P03']);
const CONNECTION_SYSTEM_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
]);

/** Classifies transport loss without inspecting provider or database messages. */
export function isDatabaseConnectionFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isErrorRecord(current)) return false;
    if (current.query === 'rollback') return true;
    const code = current.code;
    if (
      typeof code === 'string' &&
      (code.startsWith(CONNECTION_SQLSTATE_PREFIX) ||
        SHUTDOWN_SQLSTATES.has(code) ||
        CONNECTION_SYSTEM_CODES.has(code))
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function isErrorRecord(
  value: unknown,
): value is { readonly code?: unknown; readonly cause?: unknown; readonly query?: unknown } {
  return typeof value === 'object' && value !== null;
}

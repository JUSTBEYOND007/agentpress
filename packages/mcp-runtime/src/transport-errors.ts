import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

const MCP_CONNECTION_CLOSED_CODE = -32_000;
const MCP_STALE_SESSION_HTTP_CODE = 404;
const MCP_SESSION_STATE_ERROR_CODE = -32_000;
const MCP_SESSION_STATE_MESSAGES = new Set([
  'Bad Request: Server not initialized',
  'Bad Request: Mcp-Session-Id header is required',
]);

export function isMcpAuthenticationFailure(error: unknown): boolean {
  return error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403);
}

export function isMcpConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof McpError && error.code === MCP_CONNECTION_CLOSED_CODE) return true;
  // The official Streamable HTTP transport reports an expired/restarted
  // session as either a typed 404 or one of its structured -32000 HTTP 400
  // session-state responses. Authentication, rate-limit and generic upstream
  // failures retain their independent semantics.
  if (error instanceof StreamableHTTPError) {
    if (error.code === MCP_STALE_SESSION_HTTP_CODE) return true;
    if (error.code === 400 && isOfficialSessionStateResponse(error.message)) return true;
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'UND_ERR_SOCKET',
    ].includes(code)
  ) {
    return true;
  }
  const message = error.message.toLocaleLowerCase();
  return (
    /^http (404|502|503):/.test(message) ||
    [
      'econnrefused',
      'econnreset',
      'epipe',
      'enetunreach',
      'ehostunreach',
      'fetch failed',
      'transport not connected',
      'transport closed',
      'network error',
    ].some((pattern) => message.includes(pattern))
  );
}

function isOfficialSessionStateResponse(message: string): boolean {
  const bodyStart = message.indexOf('{');
  if (bodyStart < 0) return false;
  try {
    const body = JSON.parse(message.slice(bodyStart)) as {
      readonly error?: { readonly code?: unknown; readonly message?: unknown };
    };
    return (
      body.error?.code === MCP_SESSION_STATE_ERROR_CODE &&
      typeof body.error.message === 'string' &&
      MCP_SESSION_STATE_MESSAGES.has(body.error.message)
    );
  } catch {
    return false;
  }
}

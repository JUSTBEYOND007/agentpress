import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

const MCP_CONNECTION_CLOSED_CODE = -32_000;

export function isMcpAuthenticationFailure(error: unknown): boolean {
  return error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403);
}

export function isMcpConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof McpError && error.code === MCP_CONNECTION_CLOSED_CODE) return true;
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

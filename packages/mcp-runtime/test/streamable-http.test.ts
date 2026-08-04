import { describe, expect, it } from 'vitest';

import {
  createStreamableHttpDefinition,
  createStreamableHttpTransport,
} from '../src/index.js';

describe('MCP Streamable HTTP boundary', () => {
  it('uses the official SDK transport and accepts HTTPS built-ins', () => {
    const transport = createStreamableHttpTransport({ url: 'https://mcp.example.test/mcp' });
    expect(transport).toBeDefined();
    const definition = createStreamableHttpDefinition({
      serverId: 'web_research',
      version: '1.0.0',
      displayName: 'Web Research',
      transport: { url: 'https://mcp.example.test/mcp' },
    });
    expect(definition.serverId).toBe('web_research');
  });

  it('allows HTTP only for local fixtures and rejects credentials or public HTTP', () => {
    expect(() => createStreamableHttpTransport({ url: 'http://mcp.example.test/mcp' })).toThrow(
      /HTTPS/,
    );
    expect(() =>
      createStreamableHttpTransport({ url: 'https://user:password@mcp.example.test/mcp' }),
    ).toThrow(/credentials/);
    expect(() => createStreamableHttpTransport({ url: 'http://localhost:8787/mcp' })).not.toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAgentThreadSnapshot } from './agent-thread-snapshot';
import { bindAccessTokenProvider } from './authenticated-fetch';

describe('Agent thread snapshot', () => {
  afterEach(() => {
    bindAccessTokenProvider(undefined);
    vi.unstubAllGlobals();
  });

  it('loads messages and Run projections as one branch recovery boundary', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'm1', role: 'user', content: 'hi' }])),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              runId: 'r1',
              rootMessageId: 'm1',
              status: 'running',
              terminal: false,
              mode: 'direct',
              parts: [],
              artifacts: [],
              pendingDirectives: [],
              lastEventId: 2,
              createdAt: '2026-08-03T00:00:00.000Z',
            },
          ]),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    bindAccessTokenProvider(() => Promise.resolve('test-token'));

    const snapshot = await loadAgentThreadSnapshot('/v1', 'conversation-1', 'branch-1');

    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({ runId: 'r1', terminal: false });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/v1/conversations/conversation-1/branches/branch-1/messages',
      '/v1/conversations/conversation-1/branches/branch-1/runs',
    ]);
  });

  it('fails the whole recovery boundary when either fact projection is unavailable', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([])));
    vi.stubGlobal('fetch', fetch);
    bindAccessTokenProvider(() => Promise.resolve('test-token'));

    await expect(loadAgentThreadSnapshot('/v1', 'conversation-1', 'branch-1')).rejects.toThrow(
      '对话历史加载失败 (404)',
    );
  });
});

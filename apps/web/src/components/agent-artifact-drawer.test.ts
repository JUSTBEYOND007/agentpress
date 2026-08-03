import { afterEach, describe, expect, it, vi } from 'vitest';

import { artifactPreview, structuredArtifactFields } from './agent-artifact-content';
import { loadArtifact } from './agent-artifact-drawer';
import { bindAccessTokenProvider } from '../lib/authenticated-fetch';

afterEach(() => {
  bindAccessTokenProvider(undefined);
  vi.unstubAllGlobals();
});

describe('loadArtifact', () => {
  it('loads the authorized persisted version instead of trusting the projection payload', async () => {
    bindAccessTokenProvider(() => Promise.resolve('access-token'));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'artifact-1', version: 3, content: { markdown: '# 正文' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadArtifact('run/1', 'artifact/1', 3)).resolves.toMatchObject({
      id: 'artifact-1',
      version: 3,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:4000/v1/runs/run%2F1/artifacts/artifact%2F1?version=3',
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer access-token');
  });

  it.each([
    [404, '这个产物已经不存在。'],
    [409, '这个产物已有新版本，请刷新对话后查看。'],
  ])('maps HTTP %i to an actionable public error', async (status, message) => {
    bindAccessTokenProvider(() => Promise.resolve('access-token'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));

    await expect(loadArtifact('run-1', 'artifact-1', 1)).rejects.toThrow(message);
  });
});

describe('artifactPreview', () => {
  it('adapts persisted structured artifact content without stringifying internal data', () => {
    expect(artifactPreview({ markdown: '# Research' })).toBe('# Research');
    expect(artifactPreview({ content: 'Draft body' })).toBe('Draft body');
    expect(artifactPreview({ toolCallId: 'private', payload: { secret: true } })).toBe('');
  });
});

describe('structuredArtifactFields', () => {
  it('renders domain summaries while omitting opaque internal objects', () => {
    expect(
      structuredArtifactFields({ sections: [{ heading: '开篇' }], toolState: { id: 'private' } }),
    ).toEqual([{ label: '章节', values: ['开篇'] }]);
  });
});

import { describe, expect, it } from 'vitest';

import { conversationCollectionUrl } from './use-agent-conversations';

describe('Agent conversation collection', () => {
  it('uses the current article conversation boundary when an article is active', () => {
    expect(
      conversationCollectionUrl({
        apiUrl: 'http://localhost:4000/v1',
        workspaceId: 'workspace-1',
        articleId: 'article-1',
      }),
    ).toBe('http://localhost:4000/v1/articles/article-1/conversations');
  });

  it('falls back to the workspace conversation boundary without an active article', () => {
    expect(
      conversationCollectionUrl({
        apiUrl: 'http://localhost:4000/v1',
        workspaceId: 'workspace-1',
      }),
    ).toBe('http://localhost:4000/v1/workspaces/workspace-1/conversations');
  });

  it('does not invent a conversation boundary before the workspace loads', () => {
    expect(conversationCollectionUrl({ apiUrl: 'http://localhost:4000/v1' })).toBeUndefined();
  });
});

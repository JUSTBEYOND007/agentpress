import { describe, expect, it } from 'vitest';

import { contextSourcesView } from './agent-context-sources';

describe('contextSourcesView', () => {
  it('reads immutable Run context facts from the projection payload', () => {
    expect(
      contextSourcesView({
        manifest: {
          included: [{ id: 'article:a', kind: 'mention', revision: 'r1' }],
          dropped: [{ id: 'x' }],
          tokenCount: 120,
          maxInputTokens: 1000,
        },
        provider: 'openai',
        model: 'gpt-5',
      }),
    ).toEqual({
      sources: [{ id: 'article:a', kind: 'mention', revision: 'r1' }],
      droppedCount: 1,
      tokenCount: 120,
      maxInputTokens: 1000,
      provider: 'openai',
      model: 'gpt-5',
    });
  });
});

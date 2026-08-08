import { describe, expect, it } from 'vitest';

import { contextSourcesView } from './agent-context-sources';

describe('contextSourcesView', () => {
  it('reads immutable Run context facts from the projection payload', () => {
    expect(
      contextSourcesView({
        manifest: {
          included: [
            { id: 'article:a', kind: 'mention', revision: 'r1' },
            { id: 'skill:explicit-skill', kind: 'policy', revision: 'v1' },
            { id: 'skill:model-skill', kind: 'policy', revision: 'v2' },
          ],
          dropped: [{ id: 'x' }],
          tokenCount: 120,
          maxInputTokens: 1000,
        },
        provider: 'openai',
        model: 'gpt-5',
        skillSelections: {
          explicit: [{ skillId: 'explicit-skill', version: 'v1' }],
          model: [{ skillId: 'model-skill', version: 'v2' }],
        },
      }),
    ).toEqual({
      sources: [
        { id: 'article:a', kind: 'mention', revision: 'r1' },
        {
          id: 'skill:explicit-skill',
          kind: 'policy',
          revision: 'v1',
          selectionOrigin: 'explicit',
        },
        {
          id: 'skill:model-skill',
          kind: 'policy',
          revision: 'v2',
          selectionOrigin: 'model',
        },
      ],
      droppedCount: 1,
      tokenCount: 120,
      maxInputTokens: 1000,
      provider: 'openai',
      model: 'gpt-5',
    });
  });
});

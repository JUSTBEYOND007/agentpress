import { describe, expect, it } from 'vitest';

import { effectiveActionCapabilities } from '../src/action-capability-policy.js';

describe('effectiveActionCapabilities', () => {
  it('removes article.propose from free-text runs', () => {
    expect([
      ...effectiveActionCapabilities({ version: 1, source: 'free_text', grantedCapabilities: [] }, [
        'article.read',
        'article.propose',
        'web.research',
      ]),
    ]).toEqual(['article.read', 'web.research']);
  });

  it('intersects confirmed grants with host-available capabilities', () => {
    const envelope = {
      version: 1 as const,
      source: 'button' as const,
      requestedIntent: 'article_edit' as const,
      actionProposalId: '4f1be6d3-99d9-4719-8219-5dd7754a8496',
      payload: {
        instruction: '继续上一段',
        articleId: 'bb09dcbc-7f12-4d3e-bd93-d975d1f16e7f',
        baseRevisionId: '5724b935-c5c8-4a04-8155-50d911cf60ae',
        selectedBlocks: [],
      },
      grantedCapabilities: ['article.read', 'article.propose', 'forged.capability'],
    };

    expect([
      ...effectiveActionCapabilities(envelope, ['article.read', 'article.propose', 'web.research']),
    ]).toEqual(['article.read', 'article.propose']);
  });
});

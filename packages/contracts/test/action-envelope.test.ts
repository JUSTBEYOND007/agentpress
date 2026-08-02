import { describe, expect, it } from 'vitest';

import {
  createFreeTextActionEnvelope,
  parseActionEnvelope,
  type ActionEnvelopeV1,
} from '../src/index.js';

const ids = {
  action: '00000000-0000-4000-8000-000000000001',
  article: '00000000-0000-4000-8000-000000000002',
  revision: '00000000-0000-4000-8000-000000000003',
};

describe('ActionEnvelopeV1', () => {
  it('defaults ordinary messages to a capability-free free-text turn', () => {
    expect(createFreeTextActionEnvelope()).toEqual({
      version: 1,
      source: 'free_text',
      grantedCapabilities: [],
    });
  });

  it('accepts a host-confirmed article edit with validated payload and grants', () => {
    const envelope: ActionEnvelopeV1 = {
      version: 1,
      source: 'button',
      requestedIntent: 'article_edit',
      actionProposalId: ids.action,
      payload: {
        instruction: '续写当前文章的下一段',
        articleId: ids.article,
        baseRevisionId: ids.revision,
        selectedBlocks: [{ blockId: 'block-1', contentHash: 'sha256:block-1' }],
      },
      grantedCapabilities: ['article.read', 'article.propose'],
    };

    expect(parseActionEnvelope(envelope)).toEqual(envelope);
  });

  it('rejects intent, payload or capabilities smuggled into a free-text turn', () => {
    expect(() =>
      parseActionEnvelope({
        ...createFreeTextActionEnvelope(),
        requestedIntent: 'article_edit',
        grantedCapabilities: ['article.propose'],
      }),
    ).toThrow(/Free-text/);
  });

  it('rejects incomplete and unknown confirmed actions', () => {
    expect(() =>
      parseActionEnvelope({
        version: 1,
        source: 'button',
        requestedIntent: 'article_edit',
        grantedCapabilities: ['article.propose'],
      }),
    ).toThrow(/complete confirmed action/);
    expect(() =>
      parseActionEnvelope({
        version: 1,
        source: 'button',
        requestedIntent: 'write_next',
        grantedCapabilities: ['article.propose'],
      }),
    ).toThrow(/Invalid ActionEnvelopeV1/);
  });
});

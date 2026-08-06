import { describe, expect, it } from 'vitest';

import { matchFaq, searchFaqOrKnowledge, type FaqEntry } from '../src/index.js';

const entry = (question: string, semanticScore?: number): FaqEntry => ({
  id: 'faq-1',
  workspaceId: 'workspace-1',
  question,
  answer: 'Use the documented recovery flow.',
  evidence: [],
  ...(semanticScore === undefined ? {} : { semanticScore }),
  acl: ['user-1'],
});

describe('FAQ retrieval boundary', () => {
  it('prefers exact matches and enforces ACL', () => {
    const match = matchFaq(
      'workspace-1',
      '  Kafka recovery? ',
      [entry('Kafka recovery?')],
      new Set(['user-1']),
    );
    expect(match).toMatchObject({ id: 'faq-1', confidence: 1, match: 'exact' });
    expect(
      matchFaq('workspace-1', 'Kafka recovery?', [entry('Kafka recovery?')], new Set(['user-2'])),
    ).toBeUndefined();
    expect(
      matchFaq(
        'workspace-1',
        'Kafka recovery?',
        [{ ...entry('Kafka recovery?'), workspaceId: 'workspace-2', acl: ['user-1'] }],
        new Set(['user-1']),
      ),
    ).toBeUndefined();
  });

  it('accepts only high-confidence semantic matches and falls back to knowledge', () => {
    expect(
      matchFaq(
        'workspace-1',
        'How do I recover Kafka?',
        [entry('Kafka recovery', 0.9)],
        new Set(['user-1']),
      ),
    ).toMatchObject({ match: 'semantic', confidence: 0.9 });
    const result = searchFaqOrKnowledge({
      workspaceId: 'workspace-1',
      query: 'unknown',
      entries: [entry('Kafka recovery', 0.4)],
      allowedAcl: new Set(['user-1']),
      fallback: () => [],
    });
    expect(result.source).toBe('unknown');
  });
});

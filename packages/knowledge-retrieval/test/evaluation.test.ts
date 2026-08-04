import { describe, expect, it } from 'vitest';

import { evaluateRetrieval, scoreCitationResolution } from '../src/index.js';
import {
  retrievalEvalFixture,
  retrievalEvalFixtureVersion,
} from './fixtures/retrieval-eval-fixture.js';

describe('retrieval evaluation metrics', () => {
  it('computes Recall@K, MRR, NDCG, and no-answer accuracy deterministically', () => {
    const metrics = evaluateRetrieval(
      [
        {
          caseId: 'faq-hit',
          relevantChunkIds: ['a'],
          rankedChunkIds: ['b', 'a'],
          expectedNoAnswer: false,
          returnedNoAnswer: false,
        },
        {
          caseId: 'no-answer',
          relevantChunkIds: [],
          rankedChunkIds: [],
          expectedNoAnswer: true,
          returnedNoAnswer: true,
        },
      ],
      2,
    );
    expect(metrics).toMatchObject({ cases: 2, recallAtK: 0.5, mrr: 0.25, noAnswerAccuracy: 1 });
    expect(metrics.ndcg).toBeGreaterThan(0);
  });

  it('requires workspace and revision identity when resolving citations', () => {
    expect(
      scoreCitationResolution(
        [
          { evidenceId: 'e1', workspaceId: 'w1', revisionHash: 'r1' },
          { evidenceId: 'e1', workspaceId: 'w2', revisionHash: 'r1' },
          { evidenceId: 'missing', workspaceId: 'w1', revisionHash: 'r1' },
        ],
        [{ evidenceId: 'e1', workspaceId: 'w1', revisionHash: 'r1' }],
      ),
    ).toEqual({ resolved: 1, total: 3, precision: 1 / 3 });
  });

  it('runs the versioned business retrieval acceptance set', () => {
    expect(retrievalEvalFixtureVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/u);
    expect(new Set(retrievalEvalFixture.map(({ scenario }) => scenario))).toEqual(
      new Set([
        'faq_hit',
        'knowledge_recall',
        'conflicting_sources',
        'expired_document',
        'no_answer',
        'cross_workspace',
      ]),
    );
    const metrics = evaluateRetrieval(retrievalEvalFixture, 2);
    expect(metrics).toMatchObject({
      cases: 6,
      recallAtK: 0.5,
      mrr: 5 / 12,
      noAnswerAccuracy: 1,
    });
    expect(metrics.ndcg).toBeGreaterThan(0.43);
  });
});

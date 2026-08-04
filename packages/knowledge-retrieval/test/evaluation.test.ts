import { describe, expect, it } from 'vitest';

import { evaluateRetrieval, scoreCitationResolution } from '../src/index.js';

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
});


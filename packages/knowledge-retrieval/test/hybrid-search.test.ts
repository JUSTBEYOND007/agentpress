import { describe, expect, it } from 'vitest';

import { hybridSearch, type SearchCandidate } from '../src/index.js';

const candidate = (chunkId: string, text: string, acl: string[]): SearchCandidate => ({
  evidenceId: `e-${chunkId}`,
  workspaceId: 'workspace-1',
  source: 'workspace://doc',
  chunkId,
  revisionHash: 'sha256:revision',
  text,
  acl,
  lexicalScore: 0,
  semanticScore: 0.5,
  retrievalScore: 0,
  rerankScore: 0.5,
});

describe('hybrid retrieval', () => {
  it('combines lexical/semantic scores and enforces ACL before ranking', () => {
    const result = hybridSearch(
      'Kafka recovery',
      [
        candidate('allowed', 'Kafka recovery lease', ['user-1']),
        candidate('hidden', 'Kafka recovery', ['user-2']),
      ],
      new Set(['user-1']),
    );
    expect(result.map(({ chunkId }) => chunkId)).toEqual(['allowed']);
    expect(result[0]?.retrievalScore).toBeGreaterThan(0.5);
  });

  it('uses MMR to avoid returning duplicate chunks and applies temporal decay', () => {
    const result = hybridSearch(
      'Kafka recovery',
      [
        candidate('a', 'Kafka recovery lease details', ['user-1']),
        candidate('b', 'Kafka recovery lease details repeated', ['user-1']),
        candidate('c', 'Kafka retention policy', ['user-1']),
      ],
      new Set(['user-1']),
      2,
      { mmrLambda: 0.5, now: new Date('2026-01-01T00:00:00Z'), temporalHalfLifeMs: 86_400_000 },
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.chunkId).toBe('a');
    expect(result[1]?.chunkId).toBe('c');
  });
});

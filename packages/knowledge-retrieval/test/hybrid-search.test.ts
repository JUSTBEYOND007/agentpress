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
});

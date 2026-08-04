import type { RetrievalEvalCase } from '../../src/evaluation.js';

/** Versioned, provider-independent acceptance set for retrieval policy. */
export const retrievalEvalFixtureVersion = '2026-08-04.v1';

export const retrievalEvalFixture: readonly RetrievalEvalCase[] = [
  {
    caseId: 'faq-exact-recovery',
    scenario: 'faq_hit',
    query: 'How do I recover a Kafka consumer?',
    workspaceId: 'workspace-a',
    relevantChunkIds: ['faq:kafka-recovery'],
    rankedChunkIds: ['faq:kafka-recovery'],
    expectedNoAnswer: false,
    returnedNoAnswer: false,
  },
  {
    caseId: 'knowledge-semantic-recall',
    scenario: 'knowledge_recall',
    query: 'What is the editorial citation policy?',
    workspaceId: 'workspace-a',
    relevantChunkIds: ['knowledge:citation-policy:r3'],
    rankedChunkIds: ['knowledge:style:r2', 'knowledge:citation-policy:r3'],
    expectedNoAnswer: false,
    returnedNoAnswer: false,
  },
  {
    caseId: 'conflict-prefers-current-revision',
    scenario: 'conflicting_sources',
    query: 'What is the current publication deadline?',
    workspaceId: 'workspace-a',
    relevantChunkIds: ['knowledge:deadline:r4'],
    rankedChunkIds: ['knowledge:deadline:r4', 'knowledge:deadline:r2'],
    expectedNoAnswer: false,
    returnedNoAnswer: false,
  },
  {
    caseId: 'expired-document-is-not-current-fact',
    scenario: 'expired_document',
    query: 'Which embargo is active?',
    workspaceId: 'workspace-a',
    relevantChunkIds: [],
    rankedChunkIds: [],
    expectedNoAnswer: true,
    returnedNoAnswer: true,
  },
  {
    caseId: 'unknown-policy-no-answer',
    scenario: 'no_answer',
    query: 'What is the policy for an unsupported channel?',
    workspaceId: 'workspace-a',
    relevantChunkIds: [],
    rankedChunkIds: [],
    expectedNoAnswer: true,
    returnedNoAnswer: true,
  },
  {
    caseId: 'cross-workspace-result-is-denied',
    scenario: 'cross_workspace',
    query: 'Show Workspace B private launch notes',
    workspaceId: 'workspace-a',
    relevantChunkIds: [],
    rankedChunkIds: [],
    expectedNoAnswer: true,
    returnedNoAnswer: true,
  },
] as const;

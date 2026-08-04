import { describe, expect, it } from 'vitest';

import {
  articleReviewChangeFromPart,
  articleReviewChangeFromPayload,
  applyTerminalRunEvent,
  isTerminalRunEvent,
  takeUnseenArticleReviewChange,
} from './run-event-effects';
import type { RunProjection } from './agentpress-assistant-runtime';

describe('run event effects', () => {
  it('emits one review invalidation for a durable article proposal', () => {
    const change = articleReviewChangeFromPayload({
      proposalId: 'proposal-1',
      articleId: 'article-1',
    });
    const seen = new Set<string>();

    expect(change).toEqual({ proposalId: 'proposal-1', articleId: 'article-1' });
    expect(change && takeUnseenArticleReviewChange(seen, change)).toBe(true);
    expect(change && takeUnseenArticleReviewChange(seen, change)).toBe(false);
  });

  it('recovers pending proposals from projections but ignores settled proposals', () => {
    const basePart = {
      id: 'part-1',
      runId: 'run-1',
      sequence: 3,
      type: 'article-change' as const,
      status: 'article.proposal.created',
    };

    expect(
      articleReviewChangeFromPart({
        ...basePart,
        payload: { proposalId: 'proposal-1', articleId: 'article-1', proposalStatus: 'pending' },
      }),
    ).toEqual({ proposalId: 'proposal-1', articleId: 'article-1' });
    expect(
      articleReviewChangeFromPart({
        ...basePart,
        payload: { proposalId: 'proposal-1', proposalStatus: 'accepted' },
      }),
    ).toBeUndefined();
  });

  it('classifies every terminal event used to clear running and connection state', () => {
    expect(
      ['run.completed', 'run.completed_with_degradation', 'run.failed', 'run.cancelled'].every(
        isTerminalRunEvent,
      ),
    ).toBe(true);
    expect(isTerminalRunEvent('run.running')).toBe(false);
  });

  it.each([
    ['run.completed', 'completed'],
    ['run.completed_with_degradation', 'completed_with_degradation'],
    ['run.failed', 'failed'],
    ['run.cancelled', 'cancelled'],
  ])('keeps live %s settlement identical to restored projection status', (eventType, status) => {
    const restored = { ...projection, status, terminal: true };
    expect(applyTerminalRunEvent(projection, eventType)).toEqual(restored);
  });
});

const projection: RunProjection = {
  runId: 'run-1',
  rootMessageId: 'message-1',
  status: 'running',
  terminal: false,
  mode: 'direct',
  parts: [],
  artifacts: [],
  agents: [],
  pendingDirectives: [],
  lastEventId: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

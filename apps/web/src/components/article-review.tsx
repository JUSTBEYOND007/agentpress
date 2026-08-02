'use client';

import { Check, ChevronLeft, ChevronRight, EyeOff, RotateCcw, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../lib/authenticated-fetch';
import { friendlyFailure } from './agent-view-model';
import type { Proposal } from './agent-view-model';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export type ArticleReviewState = {
  readonly proposal: Proposal;
  readonly decisions: Readonly<Record<string, 'accepted' | 'rejected'>>;
  readonly visible: boolean;
  readonly activeOperationId?: string | undefined;
  readonly phase: 'pending' | 'submitting' | 'conflict' | 'error';
  readonly error?: string | undefined;
  readonly onDecision: (operationId: string, decision: 'accepted' | 'rejected') => void;
};

export function useArticleReview(
  articleId: string | undefined,
  onArticleUpdated: () => Promise<void>,
) {
  const [review, setReview] = useState<ArticleReviewState>();
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const reviewRef = useRef<ArticleReviewState | undefined>(undefined);

  useEffect(() => {
    reviewRef.current = review;
  }, [review]);

  useEffect(() => {
    reviewRef.current = undefined;
    setReview(undefined);
    setResolved(new Set());
  }, [articleId]);

  const showProposal = useCallback(
    (proposal: Proposal): void => {
      if (
        !articleId ||
        (proposal.articleId && proposal.articleId !== articleId) ||
        resolved.has(proposal.proposalId)
      )
        return;
      setReview((current) =>
        current?.proposal.proposalId === proposal.proposalId
          ? { ...current, visible: true }
          : {
              proposal,
              decisions: {},
              visible: true,
              activeOperationId: proposal.operations[0]?.operationId,
              phase: 'pending',
              onDecision: () => undefined,
            },
      );
    },
    [articleId, resolved],
  );

  const submitDecisions = useCallback(
    async (
      proposal: Proposal,
      decisions: Readonly<Record<string, 'accepted' | 'rejected'>>,
    ): Promise<void> => {
      setReview((current) =>
        current?.proposal.proposalId === proposal.proposalId
          ? { ...current, decisions, phase: 'submitting', error: undefined }
          : current,
      );
      try {
        const response = await authenticatedFetch(
          `${apiUrl}/edit-proposals/${proposal.proposalId}/decisions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decisions }),
          },
        );
        if (!response.ok) throw new Error(await response.text());
      } catch (reason) {
        const failed: ArticleReviewState = {
          ...(reviewRef.current ?? {
            proposal,
            decisions,
            visible: false,
            phase: 'conflict' as const,
            onDecision: () => undefined,
          }),
          phase: 'conflict',
          visible: false,
          error: friendlyFailure(
            reason,
            '正文已经更新，这批修改无法应用。请让助手基于最新正文重新修改。',
          ),
        };
        reviewRef.current = failed;
        setReview(failed);
        return;
      }
      setResolved((current) => new Set([...current, proposal.proposalId]));
      reviewRef.current = undefined;
      setReview(undefined);
      await onArticleUpdated().catch(() => undefined);
    },
    [onArticleUpdated],
  );

  const onDecision = useCallback(
    (operationId: string, decision: 'accepted' | 'rejected'): void => {
      const current = reviewRef.current;
      if (!current || current.phase === 'submitting') return;
      const decisions = { ...current.decisions, [operationId]: decision };
      const next = { ...current, decisions, error: undefined };
      reviewRef.current = next;
      setReview(next);
      if (current.proposal.operations.every(({ operationId: id }) => decisions[id])) {
        void submitDecisions(current.proposal, decisions);
      }
    },
    [submitDecisions],
  );

  useEffect(() => {
    setReview((current) => (current ? { ...current, onDecision } : current));
  }, [onDecision]);

  const setAll = useCallback(
    (decision: 'accepted' | 'rejected'): void => {
      const current = reviewRef.current;
      if (!current || current.phase === 'submitting') return;
      const decisions = Object.fromEntries(
        current.proposal.operations.map(({ operationId }) => [operationId, decision]),
      );
      reviewRef.current = { ...current, decisions, error: undefined };
      setReview(reviewRef.current);
      void submitDecisions(current.proposal, decisions);
    },
    [submitDecisions],
  );

  const focus = useCallback((operationId: string): void => {
    setReview((current) => (current ? { ...current, activeOperationId: operationId } : current));
    window.requestAnimationFrame(() => {
      document
        .querySelector(`[data-ai-diff-id="${CSS.escape(operationId)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, []);

  const setVisible = useCallback((visible: boolean): void => {
    setReview((current) => (current ? { ...current, visible } : current));
  }, []);

  const dismissError = useCallback((): void => {
    setReview((current) => (current ? { ...current, error: undefined } : current));
  }, []);

  const operationIds = useMemo(
    () => review?.proposal.operations.map(({ operationId }) => operationId) ?? [],
    [review],
  );
  const activeIndex = review
    ? Math.max(0, operationIds.indexOf(review.activeOperationId ?? operationIds[0] ?? ''))
    : 0;
  const moveFocus = useCallback(
    (offset: number): void => {
      if (operationIds.length === 0) return;
      const operationId =
        operationIds[(activeIndex + offset + operationIds.length) % operationIds.length];
      if (operationId) focus(operationId);
    },
    [activeIndex, focus, operationIds],
  );

  return {
    review,
    showProposal,
    onDecision,
    setAll,
    setVisible,
    dismissError,
    moveFocus,
    activeIndex,
  };
}

export function ArticleReviewToolbar({
  review,
  activeIndex,
  onDecisionAll,
  onMove,
  onVisibleChange,
}: {
  readonly review: ArticleReviewState;
  readonly activeIndex: number;
  readonly onDecisionAll: (decision: 'accepted' | 'rejected') => void;
  readonly onMove: (offset: number) => void;
  readonly onVisibleChange: (visible: boolean) => void;
}): React.JSX.Element {
  const count = review.proposal.operations.length;
  const selected = Object.keys(review.decisions).length;
  return (
    <section className="article-review-toolbar" aria-label="AI 修改审阅" aria-live="polite">
      <div className="article-review-title">
        <Sparkles aria-hidden="true" size={14} />
        <strong>AI 修改</strong>
        <span>
          {selected}/{count} 处已处理
        </span>
      </div>
      <div className="article-review-navigation">
        <button
          aria-label="上一处修改"
          disabled={count < 2 || review.phase === 'submitting'}
          onClick={() => {
            onMove(-1);
          }}
          title="上一处"
          type="button"
        >
          <ChevronLeft size={14} />
        </button>
        <span>
          {activeIndex + 1} / {count}
        </span>
        <button
          aria-label="下一处修改"
          disabled={count < 2 || review.phase === 'submitting'}
          onClick={() => {
            onMove(1);
          }}
          title="下一处"
          type="button"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="article-review-actions">
        <button
          disabled={review.phase === 'submitting'}
          onClick={() => {
            onDecisionAll('accepted');
          }}
          type="button"
        >
          <Check size={13} />
          全部接受
        </button>
        <button
          disabled={review.phase === 'submitting'}
          onClick={() => {
            onDecisionAll('rejected');
          }}
          type="button"
        >
          <X size={13} />
          全部拒绝
        </button>
        <button
          aria-label="隐藏修改"
          onClick={() => {
            onVisibleChange(false);
          }}
          title="隐藏修改"
          type="button"
        >
          <EyeOff size={14} />
        </button>
      </div>
      {review.error ? (
        <p className="article-review-error">
          <RotateCcw size={12} />
          {review.error}
        </p>
      ) : null}
    </section>
  );
}

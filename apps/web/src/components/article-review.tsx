'use client';

import { Check, ChevronLeft, ChevronRight, EyeOff, RotateCcw, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

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

  useEffect(() => {
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

  const onDecision = useCallback((operationId: string, decision: 'accepted' | 'rejected'): void => {
    setReview((current) =>
      current
        ? {
            ...current,
            decisions: { ...current.decisions, [operationId]: decision },
            error: undefined,
          }
        : current,
    );
  }, []);

  useEffect(() => {
    setReview((current) => (current ? { ...current, onDecision } : current));
  }, [onDecision]);

  const setAll = useCallback((decision: 'accepted' | 'rejected'): void => {
    setReview((current) =>
      current
        ? {
            ...current,
            decisions: Object.fromEntries(
              current.proposal.operations.map(({ operationId }) => [operationId, decision]),
            ),
            error: undefined,
          }
        : current,
    );
  }, []);

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

  const submit = useCallback(async (): Promise<void> => {
    if (!review || review.phase === 'submitting') return;
    const complete = review.proposal.operations.every(
      ({ operationId }) => review.decisions[operationId],
    );
    if (!complete) {
      setReview((current) => (current ? { ...current, error: '请先处理每一处修改。' } : current));
      return;
    }
    setReview((current) =>
      current ? { ...current, phase: 'submitting', error: undefined } : current,
    );
    try {
      const response = await authenticatedFetch(
        `${apiUrl}/edit-proposals/${review.proposal.proposalId}/decisions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decisions: review.decisions }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
      setResolved((current) => new Set([...current, review.proposal.proposalId]));
      setReview(undefined);
      await onArticleUpdated();
    } catch (reason) {
      setReview((current) =>
        current
          ? {
              ...current,
              phase: 'conflict',
              visible: false,
              error: friendlyFailure(
                reason,
                '正文已经更新，这批修改无法应用。请让助手基于最新正文重新修改。',
              ),
            }
          : current,
      );
    }
  }, [onArticleUpdated, review]);

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

  return { review, showProposal, onDecision, setAll, setVisible, submit, moveFocus, activeIndex };
}

export function ArticleReviewToolbar({
  review,
  activeIndex,
  onDecisionAll,
  onMove,
  onSubmit,
  onVisibleChange,
}: {
  readonly review: ArticleReviewState;
  readonly activeIndex: number;
  readonly onDecisionAll: (decision: 'accepted' | 'rejected') => void;
  readonly onMove: (offset: number) => void;
  readonly onSubmit: () => Promise<void>;
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
          disabled={count < 2}
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
          disabled={count < 2}
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
          onClick={() => {
            onDecisionAll('accepted');
          }}
          type="button"
        >
          <Check size={13} />
          全部接受
        </button>
        <button
          onClick={() => {
            onDecisionAll('rejected');
          }}
          type="button"
        >
          <X size={13} />
          全部拒绝
        </button>
        <button
          className="article-review-submit"
          disabled={review.phase === 'submitting'}
          onClick={() => {
            void onSubmit();
          }}
          type="button"
        >
          {review.phase === 'submitting' ? '应用中…' : '应用修改'}
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

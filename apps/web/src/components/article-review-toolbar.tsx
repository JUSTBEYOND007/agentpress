'use client';

import {
  Check,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';

import type { ArticleReviewState } from './article-review';

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
  const wholeDocument = review.proposal.reviewMode === 'document';
  const selected = Object.keys(review.decisions).length;
  return (
    <section className="article-review-toolbar" aria-label="AI 修改审阅" aria-live="polite">
      <div className="article-review-title">
        <Sparkles aria-hidden="true" size={14} />
        <strong>{wholeDocument ? '整篇文章修改' : '建议修改'}</strong>
        <span>{wholeDocument ? '1 个整体变更' : `${String(count)} 处`}</span>
      </div>
      <div className="article-review-navigation">
        <button
          aria-label="上一处修改"
          disabled={wholeDocument || count < 2 || review.phase === 'submitting'}
          onClick={() => {
            onMove(-1);
          }}
          title="上一处"
          type="button"
        >
          <ChevronLeft size={14} />
        </button>
        <span>{wholeDocument ? '整体' : `${String(activeIndex + 1)}/${String(count)}`}</span>
        <button
          aria-label="下一处修改"
          disabled={wholeDocument || count < 2 || review.phase === 'submitting'}
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
          className="article-review-accept"
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
          className="article-review-reject"
          disabled={review.phase === 'submitting'}
          onClick={() => {
            onDecisionAll('rejected');
          }}
          type="button"
        >
          <X size={13} />
          全部拒绝
        </button>
        {review.onUndoBatch ? (
          <button
            aria-label="撤销最近一批修改"
            disabled={review.phase === 'submitting'}
            onClick={review.onUndoBatch}
            title="撤销最近一批修改"
            type="button"
          >
            <RotateCcw size={14} />
          </button>
        ) : null}
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
      <span className="article-review-progress" aria-hidden="true">
        {selected > 0 ? `${String(selected)} 处已处理` : null}
      </span>
      {review.error ? (
        <p className="article-review-error">
          <span>{review.error}</span>
          {review.onReload ? (
            <button
              aria-label="重新加载最新正文"
              onClick={review.onReload}
              title="重新加载最新正文"
              type="button"
            >
              <RefreshCw aria-hidden="true" size={12} />
            </button>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

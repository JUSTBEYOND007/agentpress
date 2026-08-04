'use client';

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
  readonly onUndoBatch?: () => void;
  readonly onReload?: () => void;
};

export function useArticleReview(
  articleId: string | undefined,
  onArticleUpdated: () => Promise<void>,
) {
  const [review, setReview] = useState<ArticleReviewState>();
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const reviewRef = useRef<ArticleReviewState | undefined>(undefined);
  const decisionHandlerRef = useRef<ArticleReviewState['onDecision']>(() => undefined);
  const undoBatchHandlerRef = useRef<() => void>(() => undefined);
  const reloadHandlerRef = useRef<() => void>(() => undefined);
  const loadSequenceRef = useRef(0);

  useEffect(() => {
    reviewRef.current = review;
  }, [review]);

  const reload = useCallback(async (): Promise<void> => {
    const requestedArticleId = articleId;
    const loadSequence = ++loadSequenceRef.current;
    if (!requestedArticleId) {
      reviewRef.current = undefined;
      setReview(undefined);
      return;
    }
    const response = await authenticatedFetch(
      `${apiUrl}/articles/${requestedArticleId}/edit-proposals/pending`,
    );
    if (!response.ok) throw new Error(await response.text());
    const { proposal: value } = (await response.json()) as { readonly proposal?: unknown };
    if (loadSequence !== loadSequenceRef.current) return;
    if (typeof value !== 'object' || value === null) {
      reviewRef.current = undefined;
      setReview(undefined);
      return;
    }
    const proposal = value as Proposal & {
      readonly decisions?: Readonly<Record<string, 'accepted' | 'rejected'>>;
    };
    if (!Array.isArray(proposal.operations) || !Array.isArray(proposal.diffs)) return;
    const restored: ArticleReviewState = {
      ...createArticleReviewState(proposal, (operationId, decision) => {
        decisionHandlerRef.current(operationId, decision);
      }),
      decisions: proposal.decisions ?? {},
      onUndoBatch: () => {
        undoBatchHandlerRef.current();
      },
      onReload: () => {
        reloadHandlerRef.current();
      },
    };
    reviewRef.current = restored;
    setReview(restored);
  }, [articleId]);

  const reloadFromSource = useCallback(async (): Promise<void> => {
    await onArticleUpdated();
    await reload();
  }, [onArticleUpdated, reload]);

  useEffect(() => {
    reloadHandlerRef.current = () => {
      void reloadFromSource().catch(() => undefined);
    };
  }, [reloadFromSource]);

  useEffect(() => {
    reviewRef.current = undefined;
    setReview(undefined);
    setResolved(new Set());
    void reload().catch(() => undefined);
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [reload]);

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
            onReload: () => {
              reloadHandlerRef.current();
            },
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
      const next = { ...current, decisions, phase: 'submitting' as const, error: undefined };
      reviewRef.current = next;
      setReview(next);
      void authenticatedFetch(
        `${apiUrl}/edit-proposals/${current.proposal.proposalId}/operations/${operationId}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision }),
        },
      )
        .then(async (response) => {
          if (!response.ok) throw new Error(await response.text());
          return (await response.json()) as {
            readonly status: string;
            readonly decisions: Readonly<Record<string, 'accepted' | 'rejected'>>;
          };
        })
        .then(async (result) => {
          if (result.status !== 'pending') {
            setResolved((items) => new Set([...items, current.proposal.proposalId]));
            reviewRef.current = undefined;
            setReview(undefined);
            await onArticleUpdated().catch(() => undefined);
            return;
          }
          const persisted = {
            ...next,
            decisions: result.decisions,
            phase: 'pending' as const,
          };
          reviewRef.current = persisted;
          setReview(persisted);
        })
        .catch((reason: unknown) => {
          const failed = {
            ...current,
            phase: 'conflict' as const,
            error: friendlyFailure(reason, '这个决定没有保存，请刷新后重试。'),
          };
          reviewRef.current = failed;
          setReview(failed);
        });
    },
    [onArticleUpdated],
  );

  useEffect(() => {
    decisionHandlerRef.current = onDecision;
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
      window.requestAnimationFrame(() => {
        document
          .querySelector(`[data-ai-diff-id="${CSS.escape(operationId)}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });
  }, []);

  const openProposal = useCallback(
    async (proposal: Proposal): Promise<void> => {
      if (!articleId || (proposal.articleId && proposal.articleId !== articleId)) {
        throw new Error('这批修改不属于当前文章。');
      }
      if (resolved.has(proposal.proposalId)) throw new Error('这批正文修改已经结束。');
      await reload();
      const current = reviewRef.current;
      if (current?.proposal.proposalId !== proposal.proposalId) {
        throw new Error('这批正文修改已经失效，请查看最新正文。');
      }
      const visible = { ...current, visible: true, onDecision };
      reviewRef.current = visible;
      setReview(visible);
      const firstOperationId = current.proposal.operations[0]?.operationId;
      if (firstOperationId) focus(firstOperationId);
    },
    [articleId, focus, onDecision, reload, resolved],
  );

  const setVisible = useCallback((visible: boolean): void => {
    setReview((current) => (current ? { ...current, visible } : current));
  }, []);

  const dismissError = useCallback((): void => {
    setReview((current) => (current ? { ...current, error: undefined } : current));
  }, []);

  const undoLatestBatch = useCallback(async (): Promise<void> => {
    const current = reviewRef.current;
    const batch = [...(current?.proposal.batches ?? [])]
      .reverse()
      .find(({ status }) => status === 'active');
    if (!current || !batch) return;
    setReview((value) => (value ? { ...value, phase: 'submitting' } : value));
    try {
      const response = await authenticatedFetch(
        `${apiUrl}/edit-proposals/${current.proposal.proposalId}/batches/${batch.id}/revert`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as { readonly status?: unknown };
      if (result.status !== 'pending') {
        setResolved((items) => new Set([...items, current.proposal.proposalId]));
      }
      await reload();
    } catch (reason) {
      const failed: ArticleReviewState = {
        ...current,
        phase: 'conflict',
        error: friendlyFailure(reason, '最近一批修改没有撤销，请重新加载正文。'),
      };
      reviewRef.current = failed;
      setReview(failed);
    }
  }, [reload]);

  useEffect(() => {
    undoBatchHandlerRef.current = () => {
      void undoLatestBatch();
    };
  }, [undoLatestBatch]);

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
    reload,
    openProposal,
    onDecision,
    setAll,
    setVisible,
    dismissError,
    moveFocus,
    activeIndex,
    undoLatestBatch,
  };
}

export function createArticleReviewState(
  proposal: Proposal,
  onDecision: ArticleReviewState['onDecision'],
): ArticleReviewState {
  return {
    proposal,
    decisions: {},
    visible: true,
    activeOperationId: proposal.operations[0]?.operationId,
    phase: 'pending',
    onDecision,
  };
}

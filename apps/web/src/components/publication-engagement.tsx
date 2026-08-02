'use client';

import { Eye, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../lib/authenticated-fetch';
import { usePublicAuth } from './auth-provider';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export function PublicationEngagement({
  publicationId,
  initialDownvotes,
  initialUpvotes,
  initialViews,
}: {
  readonly publicationId: string;
  readonly initialDownvotes: number;
  readonly initialUpvotes: number;
  readonly initialViews: number;
}): React.JSX.Element {
  const auth = usePublicAuth();
  const [upvotes, setUpvotes] = useState(initialUpvotes);
  const [downvotes, setDownvotes] = useState(initialDownvotes);
  const [views, setViews] = useState(initialViews);
  const [reaction, setReaction] = useState<'up' | 'down'>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const viewerId = viewerIdFor(publicationId);
    void fetch(`${apiUrl}/publications/${encodeURIComponent(publicationId)}/views`, {
      method: 'POST',
      headers: { 'x-viewer-id': viewerId },
    })
      .then(async (response) => {
        if (!response.ok) return;
        const result = (await response.json()) as { readonly counted?: unknown };
        if (result.counted === true) setViews((value) => value + 1);
      })
      .catch(() => undefined);
  }, [publicationId]);

  async function submitReaction(nextReaction: 'up' | 'down'): Promise<void> {
    if (!auth.authenticated) {
      await auth.signIn();
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const response = await authenticatedFetch(
        `${apiUrl}/publications/${encodeURIComponent(publicationId)}/reaction`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reaction: nextReaction }),
        },
      );
      if (!response.ok) throw new Error(`评价失败 (${String(response.status)})`);
      const result = (await response.json()) as {
        readonly upvotes: number;
        readonly downvotes: number;
      };
      setReaction(nextReaction);
      setUpvotes(result.upvotes);
      setDownvotes(result.downvotes);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '评价失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <footer className="publication-engagement">
      <button
        aria-pressed={reaction === 'up'}
        disabled={pending || auth.loading}
        onClick={() => void submitReaction('up')}
        type="button"
      >
        <ThumbsUp size={15} />
        {upvotes} 赞同
      </button>
      <button
        aria-pressed={reaction === 'down'}
        disabled={pending || auth.loading}
        onClick={() => void submitReaction('down')}
        type="button"
      >
        <ThumbsDown size={15} />
        {downvotes} 反对
      </button>
      <span>
        <Eye size={15} />
        {views} 阅读
      </span>
      {!auth.authenticated && auth.configured ? <small>登录后可评价</small> : null}
      {error ? <small role="alert">{error}</small> : null}
    </footer>
  );
}

function viewerIdFor(publicationId: string): string {
  const key = `agentpress:viewer:${publicationId}`;
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(key, created);
  return created;
}

import { ArrowUpRight, Eye, ThumbsDown, ThumbsUp } from 'lucide-react';
import Link from 'next/link';

import { fetchTrending } from '../../lib/publications';

export const dynamic = 'force-dynamic';

export default async function TrendingPage(): Promise<React.JSX.Element> {
  const articles = await fetchTrending();
  return (
    <main className="public-shell">
      <header className="public-nav">
        <Link href="/">AgentPress</Link>
        <strong>热榜</strong>
      </header>
      <section className="trending-page">
        <header>
          <h1>创作热榜</h1>
          <p>按去重阅读和社区反馈聚合，每分钟更新。</p>
        </header>
        {articles.length === 0 ? (
          <p className="trending-empty">还没有已发布的文章。</p>
        ) : (
          <ol className="trending-list">
            {articles.map((article, index) => (
              <li key={article.id}>
                <span className="trend-rank">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <Link href={`/p/${article.slug}`}>{article.title}</Link>
                  <span>Edition {article.editionNumber}</span>
                </div>
                <div className="trend-stats">
                  <span>
                    <ThumbsUp size={13} />
                    {article.upvotes}
                  </span>
                  <span>
                    <ThumbsDown size={13} />
                    {article.downvotes}
                  </span>
                  <span>
                    <Eye size={13} />
                    {article.views}
                  </span>
                </div>
                <Link
                  aria-label={`阅读 ${article.title}`}
                  className="trend-open"
                  href={`/p/${article.slug}`}
                >
                  <ArrowUpRight aria-hidden="true" size={17} />
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

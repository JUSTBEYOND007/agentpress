import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PublicArticle } from '../../../components/public-article';
import { fetchPublication } from '../../../lib/publications';

export const dynamic = 'force-dynamic';

export default async function PublicationPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const article = await fetchPublication(slug);
  if (!article) notFound();
  return (
    <main className="public-shell">
      <header className="public-nav">
        <Link href="/">AgentPress</Link>
        <Link href="/trending">热榜</Link>
      </header>
      <PublicArticle article={article} />
    </main>
  );
}

import Image from 'next/image';

import type { PublicArticleDto } from '../lib/publications';
import { mediaUrl } from '../lib/publications';

export function PublicArticle({
  article,
}: {
  readonly article: PublicArticleDto;
}): React.JSX.Element {
  return (
    <article className="public-article">
      <header>
        <div className="publication-meta">
          AgentPress · Edition {article.editionNumber} ·{' '}
          {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' }).format(
            new Date(article.publishedAt),
          )}
        </div>
        <h1>{article.title}</h1>
      </header>
      {article.coverAssetId ? (
        <figure className="publication-cover">
          <Image
            alt=""
            fill
            priority
            sizes="(max-width: 800px) 100vw, 920px"
            src={mediaUrl(article.coverAssetId)}
            unoptimized
          />
          {article.coverAttribution ? <figcaption>{article.coverAttribution}</figcaption> : null}
        </figure>
      ) : null}
      <div className="publication-body">{renderDocument(article.document)}</div>
      <footer className="publication-stats">
        <span>{article.upvotes} 赞同</span>
        <span>{article.downvotes} 反对</span>
        <span>{article.views} 阅读</span>
      </footer>
    </article>
  );
}

function renderDocument(document: Readonly<Record<string, unknown>>): React.ReactNode {
  const content = Array.isArray(document.content) ? document.content : [];
  return content.map((node, index) => renderNode(node, `node-${String(index)}`));
}

function renderNode(value: unknown, key: string): React.ReactNode {
  const node = recordValue(value);
  const children = Array.isArray(node.content)
    ? node.content.map((child, index) => renderNode(child, `${key}-${String(index)}`))
    : null;
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : null;
  if (node.type === 'heading') {
    const level = recordValue(node.attrs).level;
    return level === 1 ? <h1 key={key}>{children}</h1> : <h2 key={key}>{children}</h2>;
  }
  if (node.type === 'paragraph') return <p key={key}>{children}</p>;
  if (node.type === 'blockquote') return <blockquote key={key}>{children}</blockquote>;
  if (node.type === 'bulletList') return <ul key={key}>{children}</ul>;
  if (node.type === 'orderedList') return <ol key={key}>{children}</ol>;
  if (node.type === 'listItem') return <li key={key}>{children}</li>;
  if (node.type === 'hardBreak') return <br key={key} />;
  if (node.type === 'image') {
    const attrs = recordValue(node.attrs);
    const assetId = typeof attrs.assetId === 'string' ? attrs.assetId : '';
    if (!assetId) return null;
    const alt = typeof attrs.alt === 'string' ? attrs.alt : '';
    const attribution = typeof attrs.attribution === 'string' ? attrs.attribution : '';
    return (
      <figure className="publication-inline-image" key={key}>
        <img alt={alt} loading="lazy" src={mediaUrl(assetId)} />
        {attribution ? <figcaption>{attribution}</figcaption> : null}
      </figure>
    );
  }
  return children;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

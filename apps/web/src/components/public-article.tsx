import Image from 'next/image';

import type { PublicArticleDto } from '../lib/publications';
import { mediaUrl } from '../lib/publications';
import { PublicationEngagement } from './publication-engagement';

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
      <PublicationEngagement
        initialDownvotes={article.downvotes}
        initialUpvotes={article.upvotes}
        initialViews={article.views}
        publicationId={article.id}
      />
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
  if (node.type === 'text') return renderText(node, key);
  if (node.type === 'heading') {
    const level = recordValue(node.attrs).level;
    return level === 1 ? <h1 key={key}>{children}</h1> : <h2 key={key}>{children}</h2>;
  }
  if (node.type === 'paragraph') return <p key={key}>{children}</p>;
  if (node.type === 'blockquote') return <blockquote key={key}>{children}</blockquote>;
  if (node.type === 'bulletList') return <ul key={key}>{children}</ul>;
  if (node.type === 'orderedList') return <ol key={key}>{children}</ol>;
  if (node.type === 'listItem') return <li key={key}>{children}</li>;
  if (node.type === 'taskList')
    return (
      <ul data-type="taskList" key={key}>
        {children}
      </ul>
    );
  if (node.type === 'taskItem') {
    const checked = recordValue(node.attrs).checked === true;
    return (
      <li data-checked={String(checked)} key={key}>
        <input checked={checked} readOnly type="checkbox" />
        <div>{children}</div>
      </li>
    );
  }
  if (node.type === 'codeBlock')
    return (
      <pre key={key}>
        <code>{children}</code>
      </pre>
    );
  if (node.type === 'horizontalRule') return <hr key={key} />;
  if (node.type === 'table')
    return (
      <table key={key}>
        <tbody>{children}</tbody>
      </table>
    );
  if (node.type === 'tableRow') return <tr key={key}>{children}</tr>;
  if (node.type === 'tableHeader') return <th key={key}>{children}</th>;
  if (node.type === 'tableCell') return <td key={key}>{children}</td>;
  if (node.type === 'hardBreak') return <br key={key} />;
  if (node.type === 'image') {
    const attrs = recordValue(node.attrs);
    const assetId = typeof attrs.assetId === 'string' ? attrs.assetId : '';
    const source = assetId
      ? mediaUrl(assetId)
      : typeof attrs.src === 'string' && /^https:\/\//i.test(attrs.src)
        ? attrs.src
        : '';
    if (!source) return null;
    const alt = typeof attrs.alt === 'string' ? attrs.alt : '';
    const attribution = typeof attrs.attribution === 'string' ? attrs.attribution : '';
    return (
      <figure className="publication-inline-image" key={key}>
        <img alt={alt} loading="lazy" src={source} />
        {attribution ? <figcaption>{attribution}</figcaption> : null}
      </figure>
    );
  }
  return children;
}

function renderText(node: Record<string, unknown>, key: string): React.ReactNode {
  let content: React.ReactNode = typeof node.text === 'string' ? node.text : null;
  const marks = Array.isArray(node.marks) ? node.marks : [];
  marks.forEach((value, index) => {
    const mark = recordValue(value);
    const markKey = `${key}-mark-${String(index)}`;
    if (mark.type === 'bold') content = <strong key={markKey}>{content}</strong>;
    else if (mark.type === 'italic') content = <em key={markKey}>{content}</em>;
    else if (mark.type === 'strike') content = <s key={markKey}>{content}</s>;
    else if (mark.type === 'code') content = <code key={markKey}>{content}</code>;
    else if (mark.type === 'link') {
      const href = recordValue(mark.attrs).href;
      if (typeof href === 'string' && /^https?:\/\//i.test(href))
        content = (
          <a href={href} key={markKey} rel="noopener noreferrer">
            {content}
          </a>
        );
    }
  });
  return content;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

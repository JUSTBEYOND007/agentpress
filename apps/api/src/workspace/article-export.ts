type DocumentNode = Readonly<Record<string, unknown>>;

export type ArticleExportFormat = 'markdown' | 'html' | 'json';

export function serializeDocument(document: DocumentNode, format: ArticleExportFormat): string {
  if (format === 'json') return JSON.stringify(document, null, 2);
  const nodes = Array.isArray(document.content) ? document.content : [];
  const content = nodes
    .map((node) => serializeNode(node, format, 0))
    .join(format === 'html' ? '' : '\n\n');
  return format === 'html'
    ? `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${content}</body></html>`
    : content;
}

function serializeNode(
  value: unknown,
  format: Exclude<ArticleExportFormat, 'json'>,
  depth: number,
): string {
  if (!isNode(value)) return '';
  if (value.type === 'text') return serializeText(value, format);
  const children = Array.isArray(value.content)
    ? value.content.map((child) => serializeNode(child, format, depth + 1)).join('')
    : '';
  const attrs = isNode(value.attrs) ? value.attrs : {};
  if (format === 'html') return serializeHtmlNode(value.type, attrs, children);
  return serializeMarkdownNode(value.type, attrs, children, depth);
}

function serializeText(node: DocumentNode, format: Exclude<ArticleExportFormat, 'json'>): string {
  const source = typeof node.text === 'string' ? node.text : '';
  const marks = Array.isArray(node.marks) ? node.marks.filter(isNode) : [];
  if (format === 'html') {
    return marks.reduce((content, mark) => wrapHtmlMark(content, mark), escapeHtml(source));
  }
  return marks.reduce((content, mark) => wrapMarkdownMark(content, mark), escapeMarkdown(source));
}

function serializeHtmlNode(type: unknown, attrs: DocumentNode, content: string): string {
  const level = headingLevel(attrs.level);
  if (type === 'heading') return `<h${String(level)}>${content}</h${String(level)}>`;
  if (type === 'paragraph') return `<p>${content}</p>`;
  if (type === 'blockquote') return `<blockquote>${content}</blockquote>`;
  if (type === 'bulletList') return `<ul>${content}</ul>`;
  if (type === 'orderedList') return `<ol>${content}</ol>`;
  if (type === 'listItem' || type === 'taskItem') return `<li>${content}</li>`;
  if (type === 'taskList') return `<ul data-type="taskList">${content}</ul>`;
  if (type === 'codeBlock') return `<pre><code>${content}</code></pre>`;
  if (type === 'hardBreak') return '<br>';
  if (type === 'horizontalRule') return '<hr>';
  if (type === 'image') {
    const source = safeUrl(attrs.src);
    if (!source) return '';
    return `<figure><img src="${escapeAttribute(source)}" alt="${escapeAttribute(stringAttr(attrs.alt))}" loading="lazy">${stringAttr(attrs.attribution) ? `<figcaption>${escapeHtml(stringAttr(attrs.attribution))}</figcaption>` : ''}</figure>`;
  }
  if (type === 'table') return `<table><tbody>${content}</tbody></table>`;
  if (type === 'tableRow') return `<tr>${content}</tr>`;
  if (type === 'tableHeader') return `<th>${content}</th>`;
  if (type === 'tableCell') return `<td>${content}</td>`;
  return content;
}

function serializeMarkdownNode(
  type: unknown,
  attrs: DocumentNode,
  content: string,
  depth: number,
): string {
  if (type === 'heading') return `${'#'.repeat(headingLevel(attrs.level))} ${content}`;
  if (type === 'blockquote')
    return content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  if (type === 'bulletList' || type === 'orderedList' || type === 'taskList')
    return content.trimEnd();
  if (type === 'listItem') return `${'  '.repeat(Math.max(0, depth - 2))}- ${content}\n`;
  if (type === 'taskItem')
    return `${'  '.repeat(Math.max(0, depth - 2))}- [${attrs.checked === true ? 'x' : ' '}] ${content}\n`;
  if (type === 'codeBlock') return `\`\`\`${stringAttr(attrs.language)}\n${content}\n\`\`\``;
  if (type === 'hardBreak') return '  \n';
  if (type === 'horizontalRule') return '---';
  if (type === 'image') {
    const source = safeUrl(attrs.src);
    return source ? `![${escapeMarkdown(stringAttr(attrs.alt))}](${source})` : '';
  }
  if (type === 'table') return htmlTableFallback(content);
  if (type === 'tableRow') return `<tr>${content}</tr>`;
  if (type === 'tableHeader') return `<th>${content}</th>`;
  if (type === 'tableCell') return `<td>${content}</td>`;
  return content;
}

function wrapHtmlMark(content: string, mark: DocumentNode): string {
  if (mark.type === 'bold') return `<strong>${content}</strong>`;
  if (mark.type === 'italic') return `<em>${content}</em>`;
  if (mark.type === 'strike') return `<s>${content}</s>`;
  if (mark.type === 'code') return `<code>${content}</code>`;
  if (mark.type === 'link') {
    const attrs = isNode(mark.attrs) ? mark.attrs : {};
    const href = safeUrl(attrs.href);
    return href
      ? `<a href="${escapeAttribute(href)}" rel="noopener noreferrer">${content}</a>`
      : content;
  }
  return content;
}

function wrapMarkdownMark(content: string, mark: DocumentNode): string {
  if (mark.type === 'bold') return `**${content}**`;
  if (mark.type === 'italic') return `_${content}_`;
  if (mark.type === 'strike') return `~~${content}~~`;
  if (mark.type === 'code') return `\`${content}\``;
  if (mark.type === 'link') {
    const attrs = isNode(mark.attrs) ? mark.attrs : {};
    const href = safeUrl(attrs.href);
    return href ? `[${content}](${href})` : content;
  }
  return content;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^(https?:|\/)/i.test(trimmed)) return trimmed;
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>#])/g, '\\$1');
}

function headingLevel(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(6, Math.max(1, value)) : 1;
}

function stringAttr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isNode(value: unknown): value is DocumentNode {
  return typeof value === 'object' && value !== null;
}

function htmlTableFallback(content: string): string {
  return `<table>${content}</table>`;
}

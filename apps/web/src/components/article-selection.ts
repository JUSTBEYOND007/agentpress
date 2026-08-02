import type { Editor, JSONContent } from '@tiptap/core';

export type ArticleSelectionView = {
  readonly articleId: string;
  readonly revisionId: string;
  readonly preview: string;
  readonly blocks: readonly {
    readonly blockId: string;
    readonly contentHash: string;
  }[];
};

export async function readArticleSelection(
  editor: Editor,
  articleId: string,
  revisionId: string,
): Promise<ArticleSelectionView | undefined> {
  const { from, to, empty } = editor.state.selection;
  if (empty) return undefined;

  const selected: { json: JSONContent; blockId: string; preview: string }[] = [];
  editor.state.doc.forEach((node, offset) => {
    const end = offset + node.nodeSize;
    if (to <= offset || from >= end) return;
    const attrs = node.attrs as Record<string, unknown>;
    const blockId = typeof attrs.blockId === 'string' ? attrs.blockId : '';
    if (!blockId) return;
    const json = node.toJSON() as JSONContent;
    selected.push({ json, blockId, preview: node.textContent.trim() });
  });
  if (selected.length === 0) return undefined;

  const blocks = await Promise.all(
    selected.map(async ({ blockId, json }) => ({
      blockId,
      contentHash: await hashArticleSelectionBlock(json),
    })),
  );
  const preview = selected
    .map((item) => item.preview)
    .filter(Boolean)
    .join(' ')
    .slice(0, 120);
  return { articleId, revisionId, preview, blocks };
}

export function canonicalArticleJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalArticleJson).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalArticleJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export async function hashArticleSelectionBlock(block: JSONContent): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalArticleJson(block)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

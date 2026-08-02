// Adapted from Oh My Pi Hashline snapshot anchoring (MIT), commit f446b8a8193e59b4cbd2cf487ab6fa1915e0b890.
// AgentPress uses collision-resistant SHA-256 over canonical Tiptap JSON instead of 16-bit line hashes.
import { createHash } from 'node:crypto';
import type { ArticleDocument, EditorBlock } from './contracts.js';

export function hashBlock(block: EditorBlock): string {
  return createHash('sha256').update(canonicalJson(block)).digest('hex');
}
export function hashDocument(document: ArticleDocument): string {
  return createHash('sha256').update(canonicalJson(document)).digest('hex');
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

'use client';
import type { DiffEntry } from '@agentpress/editor-patch';
import { Check, X } from 'lucide-react';

export function ArticleDiff({
  entries,
  decisions,
  onDecision,
  disabled = false,
}: {
  readonly entries: readonly DiffEntry[];
  readonly decisions: Readonly<Record<string, 'accepted' | 'rejected'>>;
  readonly onDecision: (operationId: string, decision: 'accepted' | 'rejected') => void;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <section className="article-diff" aria-label="文章修改提案">
      {entries.map((entry) => (
        <div className="diff-operation" key={entry.operationId}>
          <div className="diff-content">
            {entry.before ? (
              <div className="diff-before">
                <span>删除</span>
                <p>{blockText(entry.before)}</p>
              </div>
            ) : null}
            {entry.after ? (
              <div className="diff-after">
                <span>新增</span>
                <p>{blockText(entry.after)}</p>
              </div>
            ) : null}
          </div>
          <div className="diff-actions">
            <button
              aria-label="接受修改"
              aria-pressed={decisions[entry.operationId] === 'accepted'}
              className={decisions[entry.operationId] === 'accepted' ? 'is-selected' : ''}
              disabled={disabled}
              onClick={() => {
                onDecision(entry.operationId, 'accepted');
              }}
              title="接受"
              type="button"
            >
              <Check aria-hidden="true" size={15} />
            </button>
            <button
              aria-label="拒绝修改"
              aria-pressed={decisions[entry.operationId] === 'rejected'}
              className={decisions[entry.operationId] === 'rejected' ? 'is-selected' : ''}
              disabled={disabled}
              onClick={() => {
                onDecision(entry.operationId, 'rejected');
              }}
              title="拒绝"
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
function blockText(block: DiffEntry['before']): string {
  if (block?.type === 'image') {
    const prompt = typeof block.attrs.prompt === 'string' ? block.attrs.prompt : '';
    return prompt ? `图片 · ${prompt}` : '图片';
  }
  if (!block?.content) return block?.type ?? '';
  return block.content
    .flatMap((item) =>
      typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string'
        ? [item.text]
        : [],
    )
    .join('');
}

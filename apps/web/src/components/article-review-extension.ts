import { Extension } from '@tiptap/core';
import { DOMSerializer, Node } from '@tiptap/pm/model';
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import type { ArticleReviewState } from './article-review';

export const articleReviewPluginKey = new PluginKey<ArticleReviewState | null>('article-review');

export const ArticleReviewExtension = Extension.create({
  name: 'articleReview',

  addProseMirrorPlugins() {
    return [
      new Plugin<ArticleReviewState | null>({
        key: articleReviewPluginKey,
        state: {
          init: () => null,
          apply(transaction, value) {
            return (
              (transaction.getMeta(articleReviewPluginKey) as
                | ArticleReviewState
                | null
                | undefined) ?? value
            );
          },
        },
        props: {
          decorations(state) {
            const review = articleReviewPluginKey.getState(state);
            return review?.visible ? buildReviewDecorations(state, review) : null;
          },
        },
      }),
    ];
  },
});

export function buildReviewDecorations(
  state: EditorState,
  review: ArticleReviewState,
): DecorationSet {
  const positions = new Map<string, { from: number; to: number; node: Node }>();
  state.doc.descendants((node, position) => {
    const blockId = typeof node.attrs.blockId === 'string' ? node.attrs.blockId : undefined;
    if (blockId) positions.set(blockId, { from: position, to: position + node.nodeSize, node });
    return true;
  });

  const decorations: Decoration[] = [];
  for (const diff of review.proposal.diffs) {
    const decision = review.decisions[diff.operationId];
    if (decision === 'rejected') continue;
    const current = positions.get(diff.blockId);
    const focus = review.activeOperationId === diff.operationId;
    const stateClass = decision === 'accepted' ? 'is-accepted' : '';
    if (current && diff.before) {
      decorations.push(
        Decoration.node(current.from, current.to, {
          class: `ai-diff-before ${stateClass} ${focus ? 'is-focused' : ''}`,
          'data-ai-diff-id': diff.operationId,
        }),
      );
    }
    if (diff.after) {
      const anchor =
        current && diff.kind !== 'insert' && diff.kind !== 'move'
          ? current.to
          : insertPosition(positions, diff.operationId, review);
      decorations.push(
        Decoration.widget(
          anchor,
          () => createAfterWidget(state, review, diff.operationId, diff.kind, diff.after, focus),
          {
            key: `${review.proposal.proposalId}:${diff.operationId}`,
            side: 1,
          },
        ),
      );
    } else if (current) {
      decorations.push(
        Decoration.widget(
          current.to,
          () => createActionWidget(review, diff.operationId, focus, 'inline'),
          {
            key: `${review.proposal.proposalId}:${diff.operationId}:actions`,
            side: 1,
          },
        ),
      );
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

function insertPosition(
  positions: ReadonlyMap<string, { from: number; to: number; node: Node }>,
  operationId: string,
  review: ArticleReviewState,
): number {
  const operation = review.proposal.operations.find(({ operationId: id }) => id === operationId);
  if (!operation || (operation.kind === 'insert' && operation.afterBlockId === null)) return 0;
  const anchorId = 'afterBlockId' in operation ? operation.afterBlockId : null;
  return anchorId ? (positions.get(anchorId)?.to ?? 0) : 0;
}

function createAfterWidget(
  state: EditorState,
  review: ArticleReviewState,
  operationId: string,
  kind: string,
  block: unknown,
  focus: boolean,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = `ai-diff-after ai-diff-${kind} ${focus ? 'is-focused' : ''}`;
  wrapper.dataset.aiDiffId = operationId;
  wrapper.contentEditable = 'false';
  try {
    const node = Node.fromJSON(state.schema, block);
    wrapper.appendChild(DOMSerializer.fromSchema(state.schema).serializeNode(node));
  } catch {
    const fallback = document.createElement('span');
    fallback.textContent = '新的内容';
    wrapper.appendChild(fallback);
  }
  wrapper.appendChild(createActionWidget(review, operationId, focus));
  return wrapper;
}

function createActionWidget(
  review: ArticleReviewState,
  operationId: string,
  focus: boolean,
  placement: 'overlay' | 'inline' = 'overlay',
): HTMLElement {
  const actions = document.createElement('span');
  actions.className = `ai-diff-actions is-${placement} ${focus ? 'is-focused' : ''}`;
  actions.contentEditable = 'false';
  actions.append(
    buttonFor('接受修改', 'accepted', review, operationId),
    buttonFor('拒绝修改', 'rejected', review, operationId),
  );
  return actions;
}

function buttonFor(
  label: string,
  decision: 'accepted' | 'rejected',
  review: ArticleReviewState,
  operationId: string,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = label;
  button.ariaLabel = label;
  button.textContent = decision === 'accepted' ? '✓' : '×';
  button.dataset.decision = decision;
  button.disabled = review.phase === 'submitting';
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  button.addEventListener('click', () => {
    review.onDecision(operationId, decision);
  });
  return button;
}

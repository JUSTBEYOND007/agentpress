import { Extension } from '@tiptap/core';
import { DOMSerializer, Node } from '@tiptap/pm/model';
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import type { ArticleReviewState } from './article-review';

export const articleReviewPluginKey = new PluginKey<ArticleReviewState | null>('article-review');

export const ArticleReviewExtension = Extension.create({
  name: 'articleReview',

  addProseMirrorPlugins() {
    return [createArticleReviewPlugin()];
  },
});

export function createArticleReviewPlugin(): Plugin<ArticleReviewState | null> {
  return new Plugin<ArticleReviewState | null>({
    key: articleReviewPluginKey,
    state: {
      init: () => null,
      apply(transaction, value) {
        return (
          (transaction.getMeta(articleReviewPluginKey) as ArticleReviewState | null | undefined) ??
          value
        );
      },
    },
    props: {
      decorations(state) {
        const review = articleReviewPluginKey.getState(state);
        return review?.visible ? buildReviewDecorations(state, review) : null;
      },
    },
  });
}

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
          (view) =>
            createAfterWidget(
              view,
              review,
              diff.operationId,
              diff.kind,
              diff.after,
              focus,
              review.proposal.reviewMode !== 'document',
            ),
          {
            key: widgetKey(review, diff.operationId),
            side: 1,
            stopEvent: () => true,
            ignoreSelection: true,
          },
        ),
      );
    } else if (current) {
      decorations.push(
        Decoration.widget(
          current.to,
          (view) =>
            review.proposal.reviewMode === 'document'
              ? document.createElement('span')
              : createActionWidget(view, review, diff.operationId, focus, 'inline'),
          {
            key: `${widgetKey(review, diff.operationId)}:actions`,
            side: 1,
            stopEvent: () => true,
            ignoreSelection: true,
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
  view: EditorView,
  review: ArticleReviewState,
  operationId: string,
  kind: string,
  block: unknown,
  focus: boolean,
  showActions = true,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = `ai-diff-after ai-diff-${kind} ${focus ? 'is-focused' : ''}`;
  wrapper.dataset.aiDiffId = operationId;
  wrapper.contentEditable = 'false';
  try {
    const node = Node.fromJSON(view.state.schema, block);
    wrapper.appendChild(DOMSerializer.fromSchema(view.state.schema).serializeNode(node));
  } catch {
    const fallback = document.createElement('span');
    fallback.textContent = '新的内容';
    wrapper.appendChild(fallback);
  }
  if (showActions) wrapper.appendChild(createActionWidget(view, review, operationId, focus));
  return wrapper;
}

function createActionWidget(
  view: EditorView,
  review: ArticleReviewState,
  operationId: string,
  focus: boolean,
  placement: 'overlay' | 'inline' = 'overlay',
): HTMLElement {
  const actions = document.createElement('span');
  actions.className = `ai-diff-actions is-${placement} ${focus ? 'is-focused' : ''}`;
  actions.contentEditable = 'false';
  actions.append(
    buttonFor('接受修改', 'accepted', view, review, operationId),
    buttonFor('拒绝修改', 'rejected', view, review, operationId),
  );
  return actions;
}

function buttonFor(
  label: string,
  decision: 'accepted' | 'rejected',
  view: EditorView,
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
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dispatchReviewDecision(view.state, operationId, decision);
  });
  return button;
}

export function dispatchReviewDecision(
  state: EditorState,
  operationId: string,
  decision: 'accepted' | 'rejected',
): boolean {
  const review = articleReviewPluginKey.getState(state);
  if (
    !review?.visible ||
    review.phase === 'submitting' ||
    !review.proposal.operations.some(({ operationId: id }) => id === operationId)
  )
    return false;
  review.onDecision(operationId, decision);
  return true;
}

function widgetKey(review: ArticleReviewState, operationId: string): string {
  return [
    review.proposal.proposalId,
    operationId,
    review.decisions[operationId] ?? 'pending',
    review.phase,
  ].join(':');
}

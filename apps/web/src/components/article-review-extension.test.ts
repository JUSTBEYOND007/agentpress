import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import {
  articleReviewPluginKey,
  buildReviewDecorations,
  createArticleReviewPlugin,
  dispatchReviewDecision,
} from './article-review-extension';
import type { ArticleReviewState } from './article-review';

const schema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    paragraph: {
      group: 'block',
      attrs: { blockId: { default: null } },
      content: 'text*',
      toDOM: (node) => ['p', { 'data-block-id': String(node.attrs.blockId ?? '') }, 0] as const,
    },
    text: {},
  },
});

describe('article review decorations', () => {
  it('renders an old block and a new block without changing the document', () => {
    const document = schema.node('doc', null, [
      schema.node('paragraph', { blockId: 'block-1' }, schema.text('原文')),
    ]);
    const state = EditorState.create({ schema, doc: document });
    const review: ArticleReviewState = {
      proposal: {
        proposalId: 'proposal-1',
        status: 'pending',
        operations: [
          {
            operationId: 'operation-1',
            kind: 'replace',
            blockId: 'block-1',
            expectedHash: 'hash',
            block: {
              type: 'paragraph',
              attrs: { blockId: 'block-1' },
              content: [{ text: '新文' }],
            },
          },
        ],
        diffs: [
          {
            operationId: 'operation-1',
            kind: 'replace',
            blockId: 'block-1',
            before: {
              type: 'paragraph',
              attrs: { blockId: 'block-1' },
              content: [{ text: '原文' }],
            },
            after: {
              type: 'paragraph',
              attrs: { blockId: 'block-1' },
              content: [{ text: '新文' }],
            },
          },
        ],
      },
      decisions: {},
      visible: true,
      activeOperationId: 'operation-1',
      phase: 'pending',
      error: undefined,
      onDecision: () => undefined,
    };
    const decorations = buildReviewDecorations(state, review).find();
    expect(decorations).toHaveLength(2);
    expect(state.doc.textContent).toBe('原文');
  });

  it('dispatches a decision through the latest plugin state', () => {
    const decisions: string[] = [];
    const document = schema.node('doc', null, [
      schema.node('paragraph', { blockId: 'block-1' }, schema.text('原文')),
    ]);
    let state = EditorState.create({
      schema,
      doc: document,
      plugins: [createArticleReviewPlugin()],
    });
    const review = reviewState((operationId, decision) => {
      decisions.push(`${operationId}:${decision}`);
    });
    state = state.apply(state.tr.setMeta(articleReviewPluginKey, review));

    expect(dispatchReviewDecision(state, 'operation-1', 'accepted')).toBe(true);
    expect(decisions).toEqual(['operation-1:accepted']);

    state = state.apply(
      state.tr.setMeta(articleReviewPluginKey, { ...review, phase: 'submitting' }),
    );
    expect(dispatchReviewDecision(state, 'operation-1', 'rejected')).toBe(false);
    expect(decisions).toEqual(['operation-1:accepted']);
  });
});

function reviewState(onDecision: ArticleReviewState['onDecision']): ArticleReviewState {
  return {
    proposal: {
      proposalId: 'proposal-1',
      status: 'pending',
      operations: [
        {
          operationId: 'operation-1',
          kind: 'delete',
          blockId: 'block-1',
          expectedHash: 'hash',
        },
      ],
      diffs: [
        {
          operationId: 'operation-1',
          kind: 'delete',
          blockId: 'block-1',
          before: { type: 'paragraph', attrs: { blockId: 'block-1' } },
        },
      ],
    },
    decisions: {},
    visible: true,
    activeOperationId: 'operation-1',
    phase: 'pending',
    onDecision,
  };
}

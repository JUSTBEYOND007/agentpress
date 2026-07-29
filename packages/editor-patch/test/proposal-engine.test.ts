import { describe, expect, it } from 'vitest';
import {
  applyProposal,
  hashBlock,
  hashDocument,
  previewProposal,
  StaleEditError,
  type ArticleDocument,
  type EditorBlock,
} from '../src/index.js';
const block = (blockId: string, text: string): EditorBlock => ({
  type: 'paragraph',
  attrs: { blockId },
  content: [{ type: 'text', text }],
});
const firstBlock = block('a', 'Old');
const secondBlock = block('b', 'Keep');
const document: ArticleDocument = { type: 'doc', content: [firstBlock, secondBlock] };
describe('EditProposal engine', () => {
  it('preflights every hash before atomically applying red/green diffs', () => {
    const replacement = block('a', 'New');
    const proposal = {
      proposalId: 'p1',
      articleId: 'article',
      baseRevision: 'r1',
      operations: [
        {
          operationId: 'o1',
          kind: 'replace' as const,
          blockId: 'a',
          expectedHash: hashBlock(firstBlock),
          block: replacement,
        },
        {
          operationId: 'o2',
          kind: 'insert' as const,
          afterBlockId: 'a',
          block: block('c', 'Added'),
        },
      ],
    };
    const result = applyProposal({ document, currentRevision: 'r1', proposal });
    expect(result.document.content.map(({ attrs }) => attrs.blockId)).toEqual(['a', 'c', 'b']);
    expect(result.diffs[0]).toMatchObject({ before: document.content[0], after: replacement });
    expect(result.revisionHash).toBe(hashDocument(result.document));
  });
  it('rejects stale proposals and stale block hashes without partial writes', () => {
    const proposal = {
      proposalId: 'p1',
      articleId: 'article',
      baseRevision: 'r1',
      operations: [
        { operationId: 'o1', kind: 'delete' as const, blockId: 'a', expectedHash: 'stale' },
      ],
    };
    expect(() => applyProposal({ document, currentRevision: 'r2', proposal })).toThrow(
      StaleEditError,
    );
    expect(() => previewProposal(document, 'r1', proposal)).toThrow(/changed/);
    expect(document.content).toHaveLength(2);
  });
  it('supports per-operation acceptance and rejection', () => {
    const proposal = {
      proposalId: 'p1',
      articleId: 'article',
      baseRevision: 'r1',
      operations: [
        {
          operationId: 'delete-a',
          kind: 'delete' as const,
          blockId: 'a',
          expectedHash: hashBlock(firstBlock),
        },
        {
          operationId: 'attrs-b',
          kind: 'update_attrs' as const,
          blockId: 'b',
          expectedHash: hashBlock(secondBlock),
          attrs: { align: 'center' },
        },
      ],
    };
    const result = applyProposal({
      document,
      currentRevision: 'r1',
      proposal,
      decisions: { 'delete-a': 'rejected', 'attrs-b': 'accepted' },
    });
    expect(result.appliedOperationIds).toEqual(['attrs-b']);
    expect(result.document.content).toHaveLength(2);
    expect(result.document.content[1]?.attrs.align).toBe('center');
  });
});

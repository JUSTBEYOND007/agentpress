import {
  hashBlock,
  type ArticleDocument,
  type EditOperation,
  type EditReviewMode,
} from '@agentpress/editor-patch';

import { EditorApplicationError } from './contracts.js';

export function parseOperations(value: readonly unknown[]): readonly EditOperation[] {
  return value.map((item) => {
    if (typeof item !== 'object' || item === null)
      throw new Error('Proposal operation must be an object');
    const operation = item as Record<string, unknown>;
    if (
      typeof operation.operationId !== 'string' ||
      !['insert', 'replace', 'delete', 'move', 'update_attrs'].includes(String(operation.kind))
    ) {
      throw new Error('Proposal operation is invalid');
    }
    return item as EditOperation;
  });
}

export function normalizeOperations(
  operations: readonly EditOperation[],
  current: ArticleDocument,
  reviewMode: EditReviewMode,
): readonly EditOperation[] {
  const documentOperation = operations.find(
    (operation): operation is Extract<EditOperation, { kind: 'insert' | 'replace' }> =>
      'block' in operation && operation.block.type === 'doc',
  );
  if (!documentOperation) {
    if (operations.some((operation) => 'block' in operation && operation.block.type === 'doc'))
      throw new EditorApplicationError(
        'invalid_batch',
        'A document root cannot be used as a granular article block',
      );
    return operations;
  }
  if (reviewMode !== 'document' || operations.length !== 1)
    throw new EditorApplicationError(
      'invalid_batch',
      'A complete document must be the only operation in document review mode',
    );
  const content = documentOperation.block.content;
  if (!Array.isArray(content) || content.length === 0 || content.length > 200)
    throw new EditorApplicationError(
      'invalid_batch',
      'Document content must contain 1 to 200 blocks',
    );
  const nextBlocks = content.map((value) => {
    if (!isEditorBlock(value) || value.type === 'doc')
      throw new EditorApplicationError(
        'invalid_batch',
        'Document content contains an invalid block',
      );
    return value;
  });
  const blockIds = new Set<string>();
  for (const block of nextBlocks) {
    if (blockIds.has(block.attrs.blockId))
      throw new EditorApplicationError(
        'invalid_batch',
        `Duplicate document block ${block.attrs.blockId}`,
      );
    blockIds.add(block.attrs.blockId);
  }
  const deletes: EditOperation[] = current.content.map((block, index) => ({
    operationId: `${documentOperation.operationId}:delete:${String(index)}`,
    kind: 'delete',
    blockId: block.attrs.blockId,
    expectedHash: hashBlock(block),
  }));
  const inserts: EditOperation[] = nextBlocks.map((block, index) => ({
    operationId: `${documentOperation.operationId}:insert:${String(index)}`,
    kind: 'insert',
    afterBlockId: index === 0 ? null : (nextBlocks[index - 1]?.attrs.blockId ?? null),
    block,
  }));
  return [...deletes, ...inserts];
}

function isEditorBlock(value: unknown): value is ArticleDocument['content'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; attrs?: { blockId?: unknown } };
  return (
    typeof candidate.type === 'string' &&
    candidate.type.length > 0 &&
    candidate.type !== 'doc' &&
    typeof candidate.attrs?.blockId === 'string' &&
    candidate.attrs.blockId.length > 0
  );
}

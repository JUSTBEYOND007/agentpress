import type {
  ArticleDocument,
  DiffEntry,
  EditOperation,
  EditProposal,
  OperationDecision,
  ProposalResult,
} from './contracts.js';
import { StaleEditError } from './contracts.js';
import { hashBlock, hashDocument } from './hash.js';

export function applyProposal(input: {
  readonly document: ArticleDocument;
  readonly currentRevision: string;
  readonly proposal: EditProposal;
  readonly decisions?: Readonly<Record<string, OperationDecision>>;
}): ProposalResult {
  if (input.currentRevision !== input.proposal.baseRevision)
    throw new StaleEditError(
      'proposal',
      `Proposal targets revision ${input.proposal.baseRevision}, current revision is ${input.currentRevision}`,
    );
  validateOperationIds(input.proposal.operations);
  const accepted = input.proposal.operations.filter(
    (operation) => (input.decisions?.[operation.operationId] ?? 'accepted') === 'accepted',
  );
  const snapshot = new Map(input.document.content.map((block) => [block.attrs.blockId, block]));
  validateAll(accepted, snapshot);
  const blocks = [...input.document.content];
  const diffs: DiffEntry[] = [];
  for (const operation of accepted) applyOperation(blocks, operation, diffs);
  const document: ArticleDocument = { type: 'doc', content: blocks };
  return {
    document,
    revisionHash: hashDocument(document),
    appliedOperationIds: accepted.map(({ operationId }) => operationId),
    diffs,
  };
}

export function previewProposal(
  document: ArticleDocument,
  currentRevision: string,
  proposal: EditProposal,
): readonly DiffEntry[] {
  return applyProposal({ document, currentRevision, proposal }).diffs;
}

function validateOperationIds(operations: readonly EditOperation[]): void {
  const ids = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.operationId))
      throw new Error(`Duplicate operation ${operation.operationId}`);
    ids.add(operation.operationId);
  }
}
function validateAll(
  operations: readonly EditOperation[],
  snapshot: ReadonlyMap<string, import('./contracts.js').EditorBlock>,
): void {
  const knownIds = new Set(snapshot.keys());
  for (const operation of operations) {
    if (operation.kind === 'insert') {
      if (knownIds.has(operation.block.attrs.blockId))
        throw new Error(`Block ${operation.block.attrs.blockId} already exists`);
      if (operation.afterBlockId !== null && !knownIds.has(operation.afterBlockId))
        throw new Error(`Insert anchor ${operation.afterBlockId} does not exist`);
      knownIds.add(operation.block.attrs.blockId);
      continue;
    }
    const block = snapshot.get(operation.blockId);
    if (!block)
      throw new StaleEditError(
        operation.operationId,
        `Block ${operation.blockId} no longer exists`,
      );
    if (hashBlock(block) !== operation.expectedHash)
      throw new StaleEditError(
        operation.operationId,
        `Block ${operation.blockId} changed after the proposal was created`,
      );
    if (operation.kind === 'replace' && operation.block.attrs.blockId !== operation.blockId)
      throw new Error('Replacement must preserve blockId');
    if (
      operation.kind === 'move' &&
      operation.afterBlockId !== null &&
      !knownIds.has(operation.afterBlockId)
    )
      throw new Error(`Move anchor ${operation.afterBlockId} does not exist`);
  }
}
function applyOperation(
  blocks: import('./contracts.js').EditorBlock[],
  operation: EditOperation,
  diffs: DiffEntry[],
): void {
  if (operation.kind === 'insert') {
    const index = operation.afterBlockId === null ? 0 : indexOf(blocks, operation.afterBlockId) + 1;
    blocks.splice(index, 0, operation.block);
    diffs.push({
      operationId: operation.operationId,
      kind: operation.kind,
      blockId: operation.block.attrs.blockId,
      after: operation.block,
    });
    return;
  }
  const index = indexOf(blocks, operation.blockId);
  const before = blocks[index];
  if (!before) throw new Error(`Block ${operation.blockId} disappeared while applying proposal`);
  if (operation.kind === 'delete') {
    blocks.splice(index, 1);
    diffs.push({
      operationId: operation.operationId,
      kind: operation.kind,
      blockId: operation.blockId,
      before,
    });
    return;
  }
  if (operation.kind === 'replace') {
    blocks[index] = operation.block;
    diffs.push({
      operationId: operation.operationId,
      kind: operation.kind,
      blockId: operation.blockId,
      before,
      after: operation.block,
    });
    return;
  }
  if (operation.kind === 'update_attrs') {
    const after = {
      ...before,
      attrs: { ...before.attrs, ...operation.attrs, blockId: before.attrs.blockId },
    };
    blocks[index] = after;
    diffs.push({
      operationId: operation.operationId,
      kind: operation.kind,
      blockId: operation.blockId,
      before,
      after,
    });
    return;
  }
  blocks.splice(index, 1);
  const destination =
    operation.afterBlockId === null ? 0 : indexOf(blocks, operation.afterBlockId) + 1;
  blocks.splice(destination, 0, before);
  diffs.push({
    operationId: operation.operationId,
    kind: operation.kind,
    blockId: operation.blockId,
    before,
    after: before,
  });
}
function indexOf(blocks: readonly import('./contracts.js').EditorBlock[], blockId: string): number {
  const index = blocks.findIndex((block) => block.attrs.blockId === blockId);
  if (index < 0) throw new Error(`Block ${blockId} does not exist`);
  return index;
}

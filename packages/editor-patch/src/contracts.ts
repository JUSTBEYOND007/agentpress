export type EditorBlock = {
  readonly type: string;
  readonly attrs: Readonly<Record<string, unknown>> & { readonly blockId: string };
  readonly content?: readonly unknown[];
};
export type ArticleDocument = { readonly type: 'doc'; readonly content: readonly EditorBlock[] };
type AnchoredOperation = {
  readonly operationId: string;
  readonly blockId: string;
  readonly expectedHash: string;
};
export type EditOperation =
  | ({
      readonly kind: 'insert';
      readonly afterBlockId: string | null;
      readonly block: EditorBlock;
    } & { readonly operationId: string })
  | (AnchoredOperation & { readonly kind: 'replace'; readonly block: EditorBlock })
  | (AnchoredOperation & { readonly kind: 'delete' })
  | (AnchoredOperation & { readonly kind: 'move'; readonly afterBlockId: string | null })
  | (AnchoredOperation & {
      readonly kind: 'update_attrs';
      readonly attrs: Readonly<Record<string, unknown>>;
    });
export type EditProposal = {
  readonly proposalId: string;
  readonly articleId: string;
  readonly baseRevision: string;
  readonly operations: readonly EditOperation[];
};
export type EditReviewMode = 'granular' | 'document';
export type OperationDecision = 'accepted' | 'rejected';
export type DiffEntry = {
  readonly operationId: string;
  readonly kind: EditOperation['kind'];
  readonly blockId: string;
  readonly before?: EditorBlock;
  readonly after?: EditorBlock;
};
export type ProposalResult = {
  readonly document: ArticleDocument;
  readonly revisionHash: string;
  readonly appliedOperationIds: readonly string[];
  readonly diffs: readonly DiffEntry[];
};
export class StaleEditError extends Error {
  public constructor(
    public readonly operationId: string,
    message: string,
  ) {
    super(message);
    this.name = 'StaleEditError';
  }
}

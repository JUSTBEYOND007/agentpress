export type AutosaveBatch = {
  readonly updateId: string;
  readonly articleId: string;
  readonly userId: string;
  readonly writerLeaseId: string;
  readonly baseRevisionId: string;
  readonly schemaVersion: number;
  readonly steps: readonly unknown[];
};
export type AutosaveAck = {
  readonly updateId: string;
  readonly articleId: string;
  readonly draftId: string;
  readonly serverSequence: number;
  readonly documentHash: string;
  readonly duplicate: boolean;
};
export type CommitDraftInput = {
  readonly articleId: string;
  readonly userId: string;
  readonly writerLeaseId: string;
  readonly expectedServerSequence: number;
};
export type CommitDraftResult = {
  readonly articleId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly documentHash: string;
  readonly committedServerSequence: number;
};
export type WriterLease = {
  owns(articleId: string, userId: string, leaseId: string): Promise<boolean>;
};
export class EditorApplicationError extends Error {
  public constructor(
    public readonly code:
      | 'lease_lost'
      | 'article_not_found'
      | 'base_revision_mismatch'
      | 'draft_not_found'
      | 'draft_sequence_mismatch'
      | 'invalid_batch',
    message: string,
  ) {
    super(message);
    this.name = 'EditorApplicationError';
  }
}

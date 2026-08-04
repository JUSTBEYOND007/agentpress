export type ContextKind =
  | 'policy'
  | 'conversation'
  | 'mention'
  | 'attachment'
  | 'evidence'
  | 'memory';
export type ContextCandidate = {
  readonly id: string;
  readonly kind: ContextKind;
  readonly content: string;
  readonly tokenCount: number;
  readonly score: number;
  readonly trusted: boolean;
  readonly required?: boolean;
  readonly revision?: string;
};
export type ContextManifest = {
  readonly maxInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly included: readonly { id: string; kind: ContextKind; revision?: string }[];
  readonly dropped: readonly { id: string; reason: 'budget' | 'unaccepted_memory' }[];
  readonly tokenCount: number;
  readonly skillVersions: Readonly<Record<string, string>>;
  readonly retrievalVersion?: string;
  readonly conversationCompaction?: ConversationCompactionReference;
};
export type ConversationCompactionReference = {
  readonly id: string;
  readonly branchId: string;
  readonly version: number;
  readonly sourceFromSequence: number;
  readonly sourceThroughSequence: number;
  readonly firstKeptMessageSequence: number;
  readonly model: string;
  readonly promptVersion: string;
};
export type ContextPack = {
  readonly content: string;
  readonly manifest: ContextManifest;
  readonly contentHash: string;
};
export type MemoryCandidate = {
  readonly id: string;
  readonly workspaceId: string;
  readonly subject: string;
  readonly value: string;
  readonly valueHash: string;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'superseded' | 'deleted';
  readonly confidence: number;
  readonly supersedesId?: string;
  readonly kind?:
    | 'fact'
    | 'preference'
    | 'decision'
    | 'commitment'
    | 'goal'
    | 'event'
    | 'instruction'
    | 'learning'
    | 'error'
    | 'artifact';
  readonly importance?: number;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly sourceEvidenceIds?: readonly string[];
  readonly sourceMemoryIds?: readonly string[];
};
export type MentionTarget = {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: 'article' | 'document';
  readonly revision: string;
  readonly contentHash: string;
  readonly deleted: boolean;
};
export type BoundMention = Omit<MentionTarget, 'deleted'>;
export type SkillDefinition = {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly instructions: string;
  readonly allowedTools: readonly string[];
  readonly license?: string;
  readonly compatibility?: string;
  readonly resources?: readonly string[];
  readonly disableModelInvocation?: boolean;
  readonly hidden?: boolean;
};
export type PromptRevision = {
  readonly promptId: string;
  readonly version: string;
  readonly contentHash: string;
  readonly content: string;
  readonly snapshot: PromptSnapshot;
  readonly snapshotHash: string;
};
export type PromptSnapshot = {
  readonly schemaVersion: 1;
  readonly templateVersion: string;
  readonly variableSchemaVersion: string;
  readonly renderedContentHash: string;
  readonly blocks: readonly {
    readonly id: string;
    readonly contentHash: string;
  }[];
};
export type PromptSnapshotSource = {
  readonly templateVersion: string;
  readonly variableSchemaVersion: string;
  readonly blocks: readonly { readonly id: string; readonly content: string }[];
};
export type ModelPolicy = {
  readonly task: string;
  readonly primary: string;
  readonly fallbacks: readonly string[];
  readonly embeddingModel: string;
  readonly rerankModel: string;
  readonly imageModel: string;
};

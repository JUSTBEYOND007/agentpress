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
  readonly status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  readonly confidence: number;
  readonly supersedesId?: string;
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
};
export type PromptRevision = {
  readonly promptId: string;
  readonly version: string;
  readonly contentHash: string;
  readonly content: string;
};
export type ModelPolicy = {
  readonly task: string;
  readonly primary: string;
  readonly fallbacks: readonly string[];
  readonly embeddingModel: string;
  readonly rerankModel: string;
  readonly imageModel: string;
};

import { createHash } from 'node:crypto';
import type {
  ModelPolicy,
  PromptRevision,
  PromptSnapshot,
  PromptSnapshotSource,
} from './contracts.js';
export function createPromptRevision(
  promptId: string,
  version: string,
  content: string,
  source?: PromptSnapshotSource,
): PromptRevision {
  const contentHash = hash(content);
  const blocks = source?.blocks ?? [{ id: `${promptId}.rendered`, content }];
  if (source && (!source.templateVersion.trim() || !source.variableSchemaVersion.trim())) {
    throw new TypeError('Prompt snapshot versions must be non-empty');
  }
  if (blocks.length === 0 || blocks.length > 64) {
    throw new TypeError('Prompt snapshot requires between 1 and 64 blocks');
  }
  const seen = new Set<string>();
  for (const block of blocks) {
    if (!block.id.trim() || seen.has(block.id) || !block.content.trim()) {
      throw new TypeError('Prompt snapshot blocks require unique IDs and non-empty content');
    }
    seen.add(block.id);
  }
  const snapshot: PromptSnapshot = {
    schemaVersion: 1,
    templateVersion: source?.templateVersion ?? version,
    variableSchemaVersion: source?.variableSchemaVersion ?? 'none',
    renderedContentHash: contentHash,
    blocks: blocks.map((block) => ({ id: block.id, contentHash: hash(block.content) })),
  };
  return {
    promptId,
    version,
    content,
    contentHash,
    snapshot,
    snapshotHash: source ? hash(JSON.stringify(snapshot)) : contentHash,
  };
}

export function promptSnapshotsEqual(left: unknown, right: PromptSnapshot): boolean {
  if (!isRecord(left) || !Array.isArray(left.blocks)) return false;
  const leftBlocks = left.blocks as readonly unknown[];
  return (
    left.schemaVersion === right.schemaVersion &&
    left.templateVersion === right.templateVersion &&
    left.variableSchemaVersion === right.variableSchemaVersion &&
    left.renderedContentHash === right.renderedContentHash &&
    leftBlocks.length === right.blocks.length &&
    right.blocks.every((block, index) => samePromptBlock(leftBlocks[index], block))
  );
}

function samePromptBlock(left: unknown, right: PromptSnapshot['blocks'][number]): boolean {
  return isRecord(left) && left.id === right.id && left.contentHash === right.contentHash;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export class ModelPolicyCatalog {
  public constructor(private readonly policies: readonly ModelPolicy[]) {}
  public select(
    task: string,
    unavailable: ReadonlySet<string> = new Set(),
  ): { model: string; policy: ModelPolicy; fallbackUsed: boolean } {
    const policy = this.policies.find((item) => item.task === task);
    if (!policy) throw new Error(`No model policy for ${task}`);
    const model = [policy.primary, ...policy.fallbacks].find(
      (candidate) => !unavailable.has(candidate),
    );
    if (!model) throw new Error(`No available model for ${task}`);
    return { model, policy, fallbackUsed: model !== policy.primary };
  }
}
export async function runReviewGate<T>(
  draft: T,
  review: (value: T, round: number) => Promise<{ accepted: boolean; revision?: T }>,
  maxRounds = 2,
): Promise<{ value: T; rounds: number; accepted: boolean }> {
  if (maxRounds < 1 || maxRounds > 3)
    throw new RangeError('ReviewGate rounds must be between 1 and 3');
  let value = draft;
  for (let round = 1; round <= maxRounds; round += 1) {
    const result = await review(value, round);
    if (result.accepted) return { value: result.revision ?? value, rounds: round, accepted: true };
    if (result.revision !== undefined) value = result.revision;
  }
  return { value, rounds: maxRounds, accepted: false };
}

import { createHash } from 'node:crypto';
import type { ModelPolicy, PromptRevision } from './contracts.js';
export function createPromptRevision(
  promptId: string,
  version: string,
  content: string,
): PromptRevision {
  return {
    promptId,
    version,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
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

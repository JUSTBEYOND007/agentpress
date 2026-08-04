import { createHash } from 'node:crypto';
import type {
  ContextCandidate,
  ContextKind,
  ContextPack,
  ConversationCompactionReference,
} from './contracts.js';

const shares: Readonly<Record<ContextKind, number>> = {
  policy: 0.1,
  conversation: 0.2,
  mention: 0.2,
  attachment: 0.2,
  evidence: 0.2,
  memory: 0.1,
};

export function assembleContext(input: {
  readonly contextWindow: number;
  readonly candidates: readonly ContextCandidate[];
  readonly acceptedMemoryIds: ReadonlySet<string>;
  readonly skillVersions?: Readonly<Record<string, string>>;
  readonly retrievalVersion?: string;
  readonly conversationCompaction?: ConversationCompactionReference;
}): ContextPack {
  const reservedOutputTokens = Math.ceil(input.contextWindow * 0.2);
  const maxInputTokens = input.contextWindow - reservedOutputTokens;
  const included: ContextCandidate[] = [];
  const dropped: { id: string; reason: 'budget' | 'unaccepted_memory' }[] = [];
  let totalUsed = 0;
  for (const kind of Object.keys(shares) as ContextKind[]) {
    let used = 0;
    const budget = Math.floor(maxInputTokens * shares[kind]);
    const ranked = input.candidates
      .filter((item) => item.kind === kind)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    for (const item of ranked) {
      if (kind === 'memory' && !input.acceptedMemoryIds.has(item.id)) {
        dropped.push({ id: item.id, reason: 'unaccepted_memory' });
        continue;
      }
      const required = kind === 'policy' || item.required === true;
      if (required && totalUsed + item.tokenCount > maxInputTokens) {
        throw new Error(`Required context ${item.id} exceeds the model input budget`);
      }
      if (
        !required &&
        (used + item.tokenCount > budget || totalUsed + item.tokenCount > maxInputTokens)
      ) {
        dropped.push({ id: item.id, reason: 'budget' });
        continue;
      }
      included.push(item);
      used += item.tokenCount;
      totalUsed += item.tokenCount;
    }
  }
  const content = included
    .map(
      (item) =>
        `<context id="${item.id}" kind="${item.kind}" trust="${item.trusted ? 'trusted' : 'untrusted'}">\n${item.content}\n</context>`,
    )
    .join('\n');
  const manifest = {
    maxInputTokens,
    reservedOutputTokens,
    included: included.map(({ id, kind, revision }) =>
      revision ? { id, kind, revision } : { id, kind },
    ),
    dropped,
    tokenCount: included.reduce((sum, item) => sum + item.tokenCount, 0),
    skillVersions: input.skillVersions ?? {},
    ...(input.retrievalVersion ? { retrievalVersion: input.retrievalVersion } : {}),
    ...(input.conversationCompaction
      ? { conversationCompaction: input.conversationCompaction }
      : {}),
  };
  return {
    content,
    manifest,
    contentHash: createHash('sha256').update(JSON.stringify({ content, manifest })).digest('hex'),
  };
}

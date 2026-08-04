import { createHash } from 'node:crypto';
import type { MemoryCandidate } from './contracts.js';

export function proposeMemory(
  input: Omit<MemoryCandidate, 'valueHash' | 'status'>,
  existing: readonly MemoryCandidate[],
): MemoryCandidate {
  if (input.confidence < 0 || input.confidence > 1)
    throw new RangeError('Memory confidence must be between 0 and 1');
  const valueHash = createHash('sha256').update(input.value.trim()).digest('hex');
  const duplicate = existing.find(
    (item) =>
      item.workspaceId === input.workspaceId &&
      item.subject === input.subject &&
      item.valueHash === valueHash &&
      item.status !== 'rejected',
  );
  if (duplicate) return duplicate;
  const active = existing.find(
    (item) =>
      item.workspaceId === input.workspaceId &&
      item.subject === input.subject &&
      item.status === 'accepted',
  );
  return {
    ...input,
    value: input.value.trim(),
    valueHash,
    status: 'pending',
    ...(active ? { supersedesId: active.id } : {}),
  };
}

export function decideMemory(
  candidate: MemoryCandidate,
  decision: 'accepted' | 'rejected',
): MemoryCandidate {
  if (candidate.status !== 'pending')
    throw new Error('Only pending memory candidates can be decided');
  return { ...candidate, status: decision };
}

export function retrieveAcceptedMemory(
  workspaceId: string,
  candidates: readonly MemoryCandidate[],
): readonly MemoryCandidate[] {
  return candidates.filter(
    (item) => item.workspaceId === workspaceId && item.status === 'accepted',
  );
}

export type MemoryRetrievalOptions = {
  readonly userId?: string;
  readonly now?: Date;
  readonly limit?: number;
  readonly halfLifeMs?: number;
};

/** Hybrid lexical/confidence/importance/temporal recall over accepted candidates. */
export function retrieveRelevantMemory(
  workspaceId: string,
  query: string,
  candidates: readonly (MemoryCandidate & { readonly userId?: string })[],
  options: MemoryRetrievalOptions = {},
): readonly MemoryCandidate[] {
  const limit = options.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Memory limit must be positive');
  const halfLife = options.halfLifeMs ?? 30 * 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(halfLife) || halfLife <= 0) throw new RangeError('Memory half-life must be positive');
  const now = options.now ?? new Date();
  const terms = tokenize(query);
  return candidates
    .filter(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.status === 'accepted' &&
        (options.userId === undefined || candidate.userId === options.userId) &&
        isCurrentlyValid(candidate, now),
    )
    .map((candidate) => {
      const lexical = lexicalScore(terms, `${candidate.subject} ${candidate.value}`);
      const age = Math.max(0, now.getTime() - Date.parse(candidate.validFrom ?? now.toISOString()));
      const temporal = Math.pow(0.5, age / halfLife);
      const score =
        0.45 * lexical +
        0.25 * clamp(candidate.confidence) +
        0.2 * clamp(candidate.importance ?? 0.5) +
        0.1 * temporal;
      return { candidate, score };
    })
    .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

/** Creates a new replacement candidate while preserving the source candidates unchanged. */
export function consolidateMemory(
  input: Omit<MemoryCandidate, 'valueHash' | 'status' | 'supersedesId'>,
  sources: readonly MemoryCandidate[],
): MemoryCandidate {
  const accepted = sources.filter(
    (source) => source.workspaceId === input.workspaceId && source.status === 'accepted',
  );
  const supersedesId = accepted.at(-1)?.id;
  return {
    ...proposeMemory(input, sources),
    ...(supersedesId ? { supersedesId } : {}),
  };
}

function isCurrentlyValid(candidate: MemoryCandidate, now: Date): boolean {
  const timestamp = now.getTime();
  if (candidate.validFrom && Date.parse(candidate.validFrom) > timestamp) return false;
  return !(candidate.validUntil && Date.parse(candidate.validUntil) <= timestamp);
}

function tokenize(value: string): ReadonlySet<string> {
  return new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function lexicalScore(query: ReadonlySet<string>, text: string): number {
  if (query.size === 0) return 0;
  const terms = tokenize(text);
  return [...query].filter((term) => terms.has(term)).length / query.size;
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

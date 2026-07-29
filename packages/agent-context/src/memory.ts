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

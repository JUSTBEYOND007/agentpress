import type { RunPart, RunProjection } from './agent-runtime-contracts';

export type ArticleReviewChange = {
  readonly proposalId: string;
  readonly articleId?: string;
};

export function isTerminalRunEvent(eventType: string): boolean {
  return (
    eventType === 'run.completed' ||
    eventType === 'run.completed_with_degradation' ||
    eventType === 'run.failed' ||
    eventType === 'run.cancelled'
  );
}

export function terminalRunStatus(eventType: string): string {
  return eventType.slice('run.'.length);
}

export function applyTerminalRunEvent(projection: RunProjection, eventType: string): RunProjection {
  if (!isTerminalRunEvent(eventType)) return projection;
  return { ...projection, status: terminalRunStatus(eventType), terminal: true };
}

export function articleReviewChangeFromPayload(
  payload: Readonly<Record<string, unknown>>,
): ArticleReviewChange | undefined {
  const proposalId = stringValue(payload.proposalId);
  if (!proposalId) return undefined;
  const articleId = stringValue(payload.articleId);
  return { proposalId, ...(articleId ? { articleId } : {}) };
}

export function articleReviewChangeFromPart(part: RunPart): ArticleReviewChange | undefined {
  if (part.type !== 'article-change') return undefined;
  const proposalStatus = stringValue(part.payload.proposalStatus);
  if (proposalStatus && proposalStatus !== 'pending') return undefined;
  return articleReviewChangeFromPayload(part.payload);
}

export function takeUnseenArticleReviewChange(
  seenProposalIds: Set<string>,
  change: ArticleReviewChange,
): boolean {
  if (seenProposalIds.has(change.proposalId)) return false;
  seenProposalIds.add(change.proposalId);
  return true;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

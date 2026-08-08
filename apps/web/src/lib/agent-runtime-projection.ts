import type { ThreadMessageLike } from '@assistant-ui/react';

import type { StableAgentMessage } from './agent-thread-snapshot';
import { recordValue, stringValue } from './agent-runtime-api';
import type {
  AgentMessage,
  ArticleOutcomePresentation,
  RunPart,
  RunProcessPresentation,
  RunProjection,
} from './agent-runtime-contracts';
import {
  executionItems,
  isConsumerHiddenDiagnostic,
  isProcessPart,
  isStaleTerminalActivity,
  processDurationMs,
  sanitizeProcessPart,
  sanitizeVisiblePart,
} from './agent-execution-projection';

export function buildRunTurns(
  messages: readonly StableAgentMessage[],
  projections: readonly RunProjection[],
  liveContent: readonly { readonly runId: string; readonly text: string }[],
): readonly AgentMessage[] {
  const byRoot = new Map(projections.map((projection) => [projection.rootMessageId, projection]));
  const liveByRunId = new Map(liveContent.map((content) => [content.runId, content.text]));
  const projectedRunIds = new Set(projections.map(({ runId }) => runId));
  const result: AgentMessage[] = [];
  let skipNextAssistant = false;
  for (const message of messages) {
    if (message.role === 'assistant' && skipNextAssistant) {
      skipNextAssistant = false;
      continue;
    }
    result.push({ id: message.id, role: message.role, text: message.content, status: 'complete' });
    if (message.role !== 'user') continue;
    const projection = byRoot.get(message.id);
    if (!projection) continue;
    const liveText = liveByRunId.get(projection.runId);
    result.push({
      id: `run:${projection.runId}`,
      role: 'assistant',
      projection,
      ...(liveText ? { text: liveText } : {}),
      status: projection.terminal ? 'complete' : 'running',
    });
    skipNextAssistant = projectedRunIds.has(projection.runId);
  }
  return result;
}

export function convertAgentMessage(message: AgentMessage): ThreadMessageLike {
  const projection = message.projection;
  const content = projection
    ? projectionContent(projection, message.text)
    : [{ type: 'text' as const, text: message.text ?? '' }];
  return {
    id: message.id,
    role: message.role,
    content,
    ...(message.role === 'assistant'
      ? {
          status:
            message.status === 'running'
              ? ({ type: 'running' } as const)
              : message.status === 'error'
                ? ({ type: 'incomplete', reason: 'error' } as const)
                : ({ type: 'complete', reason: 'stop' } as const),
        }
      : {}),
  };
}

export function upsertProjection(
  current: readonly RunProjection[],
  projection: RunProjection,
): readonly RunProjection[] {
  return [...current.filter(({ runId }) => runId !== projection.runId), projection].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function projectionContent(
  projection: RunProjection,
  liveText?: string,
): ThreadMessageLike['content'] {
  const parts: (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'data'; readonly name: string; readonly data: unknown }
  )[] = [];
  const projectedParts = augmentedProjectionParts(projection);
  const processParts = projectedParts
    .filter((part) => isProcessPart(part, projection.terminal))
    .map(sanitizeProcessPart);
  const processPartIds = new Set(processParts.map(({ id }) => id));
  const process: RunProcessPresentation = {
    runId: projection.runId,
    status: projection.status,
    terminal: projection.terminal,
    durationMs: processDurationMs(projectedParts),
    parts: processParts,
    items: executionItems(processParts, projectedParts),
  };
  const articleProposalIds = new Set(
    projectedParts.flatMap((part) => {
      if (part.type !== 'article-change') return [];
      const proposalId = proposalIdFromPart(part);
      return proposalId ? [proposalId] : [];
    }),
  );
  const attachedReceiptIds = new Set(
    projectedParts.flatMap((part) => {
      if (part.type !== 'text') return [];
      const targetId = receiptTargetId(part);
      return targetId && articleProposalIds.has(targetId) ? [targetId] : [];
    }),
  );
  let processAttached = false;

  for (const part of projectedParts) {
    if (
      processPartIds.has(part.id) ||
      isConsumerHiddenDiagnostic(part.type) ||
      isStaleTerminalActivity(part, projection.terminal)
    )
      continue;
    if (part.type === 'text') {
      const message = recordValue(part.payload.message);
      const text = stringValue(message.content) || stringValue(part.payload.content);
      const targetId = receiptTargetId(part);
      if (text && (!targetId || !attachedReceiptIds.has(targetId))) {
        parts.push({ type: 'text', text });
      }
      continue;
    }
    if (part.type === 'article-change') {
      if (!processAttached) {
        parts.push({
          type: 'data',
          name: 'agentpress-article-outcome',
          data: { part, process } satisfies ArticleOutcomePresentation,
        });
        processAttached = true;
        continue;
      }
    }
    if (part.type === 'artifact') {
      const visiblePart = visibleArtifactPart(part, articleProposalIds);
      if (!visiblePart) continue;
      parts.push({ type: 'data', name: 'agentpress-run-part', data: visiblePart });
      continue;
    }
    parts.push({ type: 'data', name: 'agentpress-run-part', data: sanitizeVisiblePart(part) });
  }
  if (liveText && !projection.parts.some(({ type }) => type === 'text')) {
    parts.push({ type: 'text', text: liveText });
  }
  if (!processAttached && process.parts.length > 0) {
    const processPart = {
      type: 'data',
      name: 'agentpress-run-process',
      data: process,
    } as const;
    parts.push(processPart);
  }
  return parts;
}

function augmentedProjectionParts(projection: RunProjection): readonly RunPart[] {
  const projected = [...projection.parts];
  if (projection.context && !projected.some(({ type }) => type === 'context')) {
    projected.push({
      id: `${projection.runId}:context`,
      runId: projection.runId,
      sequence: -1,
      type: 'context',
      status: 'context.ready',
      payload: projection.context,
    });
  }
  if (projection.artifacts.length > 0 && !projected.some(({ type }) => type === 'artifact')) {
    projected.push({
      id: `${projection.runId}:artifacts`,
      runId: projection.runId,
      sequence: projection.lastEventId + 1,
      type: 'artifact',
      status: 'artifact.available',
      payload: { artifacts: projection.artifacts },
    });
  }
  if (
    !projection.terminal &&
    !projected.some(({ type }) => type === 'reasoning' || type === 'activity')
  ) {
    projected.push({
      id: `${projection.runId}:status`,
      runId: projection.runId,
      sequence: 0,
      type: 'activity',
      status: `run.${projection.status}`,
      payload: { mode: projection.mode, activePlanRevision: projection.activePlanRevision },
    });
  }
  return projected.sort((left, right) => left.sequence - right.sequence);
}

function proposalIdFromPart(part: RunPart): string | undefined {
  const output = recordValue(part.payload.output);
  return stringValue(part.payload.proposalId) || stringValue(output.proposalId) || undefined;
}

function receiptTargetId(part: RunPart): string | undefined {
  const message = recordValue(part.payload.message);
  const presentation = recordValue(message.presentation);
  return presentation.kind === 'outcome_receipt' && presentation.targetType === 'article-change'
    ? stringValue(presentation.targetId) || undefined
    : undefined;
}

function artifactTargetId(artifact: Readonly<Record<string, unknown>>): string | undefined {
  if (stringValue(artifact.type) !== 'EditProposal') return undefined;
  const presentation = recordValue(artifact.presentation);
  return presentation.kind === 'outcome_artifact' && presentation.targetType === 'article-change'
    ? stringValue(presentation.targetId) || undefined
    : undefined;
}

function visibleArtifactPart(
  part: RunPart,
  articleProposalIds: ReadonlySet<string>,
): RunPart | undefined {
  const targetId = artifactTargetId(part.payload);
  if (targetId && articleProposalIds.has(targetId)) return undefined;

  const artifacts = Array.isArray(part.payload.artifacts) ? part.payload.artifacts : undefined;
  if (!artifacts) return part;
  const visibleArtifacts = artifacts.filter((artifact) => {
    const record = recordValue(artifact);
    const artifactProposalId = artifactTargetId(record);
    return !artifactProposalId || !articleProposalIds.has(artifactProposalId);
  });
  if (visibleArtifacts.length === 0) return undefined;
  if (visibleArtifacts.length === artifacts.length) return part;
  return { ...part, payload: { ...part.payload, artifacts: visibleArtifacts } };
}

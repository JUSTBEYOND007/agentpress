import type { ThreadMessageLike } from '@assistant-ui/react';

import type { StableAgentMessage } from './agent-thread-snapshot';
import { recordValue, stringValue } from './agent-runtime-api';
import type { AgentMessage, RunPart, RunProjection } from './agent-runtime-contracts';

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

function projectionContent(
  projection: RunProjection,
  liveText?: string,
): ThreadMessageLike['content'] {
  const parts: (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'data'; readonly name: string; readonly data: unknown }
  )[] = [];
  let activitySteps: RunPart[] = [];
  const flushActivitySteps = (): void => {
    if (activitySteps.length === 0) return;
    parts.push({
      type: 'data',
      name: 'agentpress-execution-timeline',
      data: { steps: activitySteps },
    });
    activitySteps = [];
  };
  for (const part of [...projection.parts].sort((left, right) => left.sequence - right.sequence)) {
    if (part.type === 'activity') {
      activitySteps.push(part);
      continue;
    }
    flushActivitySteps();
    if (part.type === 'text') {
      const message = recordValue(part.payload.message);
      const text = stringValue(message.content) || stringValue(part.payload.content);
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    parts.push({ type: 'data', name: 'agentpress-run-part', data: part });
  }
  flushActivitySteps();
  if (liveText && !projection.parts.some(({ type }) => type === 'text')) {
    parts.push({ type: 'text', text: liveText });
  }
  if (
    projection.artifacts.length > 0 &&
    !projection.parts.some(({ type }) => type === 'artifact')
  ) {
    parts.push({
      type: 'data',
      name: 'agentpress-run-part',
      data: {
        id: `${projection.runId}:artifacts`,
        runId: projection.runId,
        sequence: projection.lastEventId + 1,
        type: 'artifact',
        status: 'artifact.available',
        payload: { artifacts: projection.artifacts },
      } satisfies RunPart,
    });
  }
  if (projection.context) {
    parts.unshift({
      type: 'data',
      name: 'agentpress-run-part',
      data: {
        id: `${projection.runId}:context`,
        runId: projection.runId,
        sequence: -1,
        type: 'context',
        status: 'context.ready',
        payload: projection.context,
      } satisfies RunPart,
    });
  }
  if (parts.length === 0 || !projection.terminal) {
    parts.unshift({
      type: 'data',
      name: 'agentpress-run-part',
      data: {
        id: `${projection.runId}:status`,
        runId: projection.runId,
        sequence: 0,
        type: 'activity',
        status: `run.${projection.status}`,
        payload: { mode: projection.mode, activePlanRevision: projection.activePlanRevision },
      } satisfies RunPart,
    });
  }
  return parts;
}

import { describe, expect, it } from 'vitest';

import type { RunPart, RunProjection } from './agent-runtime-contracts';
import { projectionContent } from './agent-runtime-projection';

describe('run presentation projection', () => {
  it('attaches one process disclosure to a matching article outcome and hides only its receipt', () => {
    const content = projectionContent(
      projection([
        part('context', 'context.ready', 1, { manifest: { included: [], tokenCount: 20 } }),
        part('activity', 'tool.succeeded', 2, { summary: '读取正文' }),
        articleChange('proposal-1', 3),
        receipt('proposal-1', 4),
        usage(5),
      ]),
    );

    expect(names(content)).toEqual(['agentpress-article-outcome']);
    expect(texts(content)).toEqual([]);
    const outcome = dataByName(content, 'agentpress-article-outcome');
    expect((outcome.process as { parts: RunPart[] }).parts.map(({ type }) => type)).toEqual([
      'context',
      'activity',
      'usage',
    ]);
  });

  it('keeps a receipt visible when its structured target does not match the proposal', () => {
    const content = projectionContent(
      projection([articleChange('proposal-1', 1), receipt('proposal-other', 2), usage(3)]),
    );

    expect(texts(content)).toEqual(['已生成修改，等待审阅。']);
    expect(names(content)).toEqual(['agentpress-run-part', 'agentpress-run-process']);
  });

  it('keeps an ordinary answer and places one process disclosure after it', () => {
    const content = projectionContent(projection([text('这是普通回答。', 1), usage(2)]));

    expect(texts(content)).toEqual(['这是普通回答。']);
    expect(names(content)).toEqual(['agentpress-run-process']);
    expect(content.at(-1)).toMatchObject({ type: 'data', name: 'agentpress-run-process' });
  });

  it('puts the compact process status first while a run is active and leaves warnings visible', () => {
    const content = projectionContent(
      projection([part('warning', 'run.failed', 2, {})], false, 'running'),
    );

    expect(content[0]).toMatchObject({ type: 'data', name: 'agentpress-run-process' });
    expect(content[1]).toMatchObject({ type: 'data', name: 'agentpress-run-part' });
  });
});

function projection(
  parts: readonly RunPart[],
  terminal = true,
  status = terminal ? 'completed' : 'running',
): RunProjection {
  return {
    runId: 'run-1',
    rootMessageId: 'message-1',
    status,
    terminal,
    mode: 'direct',
    parts,
    artifacts: [],
    agents: [],
    pendingDirectives: [],
    lastEventId: 10,
    createdAt: '2026-08-06T00:00:00.000Z',
  };
}

function part(
  type: RunPart['type'],
  status: string,
  sequence: number,
  payload: Readonly<Record<string, unknown>>,
): RunPart {
  return { id: `${type}-${String(sequence)}`, runId: 'run-1', sequence, type, status, payload };
}

function articleChange(proposalId: string, sequence: number): RunPart {
  return part('article-change', 'article.proposal.created', sequence, {
    proposalId,
    operations: [{ operationId: 'operation-1' }],
    diffs: [],
  });
}

function receipt(targetId: string, sequence: number): RunPart {
  return part('text', 'message.completed', sequence, {
    message: {
      content: '已生成修改，等待审阅。',
      presentation: { kind: 'outcome_receipt', targetType: 'article-change', targetId },
    },
  });
}

function text(content: string, sequence: number): RunPart {
  return part('text', 'message.completed', sequence, { message: { content } });
}

function usage(sequence: number): RunPart {
  return part('usage', 'execution.facts', sequence, {
    durationMs: 19_000,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0 },
  });
}

function names(content: ReturnType<typeof projectionContent>): string[] {
  if (typeof content === 'string') return [];
  return content.flatMap((item) => (item.type === 'data' ? [item.name] : []));
}

function texts(content: ReturnType<typeof projectionContent>): string[] {
  if (typeof content === 'string') return [content];
  return content.flatMap((item) => (item.type === 'text' ? [item.text] : []));
}

function dataByName(
  content: ReturnType<typeof projectionContent>,
  name: string,
): Record<string, unknown> {
  if (typeof content === 'string') return {};
  const item = content.find((candidate) => candidate.type === 'data' && candidate.name === name);
  return item?.type === 'data' && typeof item.data === 'object' && item.data !== null
    ? (item.data as Record<string, unknown>)
    : {};
}

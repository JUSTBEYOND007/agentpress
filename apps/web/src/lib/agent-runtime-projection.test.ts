import { describe, expect, it } from 'vitest';

import type { RunPart, RunProjection } from './agent-runtime-contracts';
import { executionItems } from './agent-execution-projection';
import { projectionContent } from './agent-runtime-projection';

describe('run presentation projection', () => {
  it('attaches one process disclosure to a matching article outcome and hides only its receipt', () => {
    const content = projectionContent(
      projection([
        part('context', 'context.ready', 1, { manifest: { included: [], tokenCount: 20 } }),
        part('activity', 'tool.succeeded', 2, { toolId: 'article.read_current' }),
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
    expect(outcome.process).toMatchObject({
      items: [{ kind: 'utility-group', count: 1, status: 'completed' }],
    });
    expect(outcome.process).toMatchObject({ durationMs: 19_000 });
  });

  it('keeps a receipt visible when its structured target does not match the proposal', () => {
    const content = projectionContent(
      projection([articleChange('proposal-1', 1), receipt('proposal-other', 2), usage(3)]),
    );

    expect(texts(content)).toEqual(['已生成修改，等待审阅。']);
    expect(names(content)).toEqual(['agentpress-article-outcome']);
  });

  it('attaches process disclosure to an article outcome even without a receipt marker', () => {
    const content = projectionContent(projection([articleChange('proposal-1', 1), usage(2)]));

    expect(names(content)).toEqual(['agentpress-article-outcome']);
  });

  it('merges only a structurally matching EditProposal artifact into the article outcome', () => {
    const content = projectionContent(
      projection([
        articleChange('proposal-1', 1),
        artifact('EditProposal', 'proposal-1', 2),
        artifact('EditProposal', 'proposal-other', 3),
        artifact('ResearchBrief', undefined, 4),
        artifact('EditProposal', undefined, 5),
        usage(6),
      ]),
    );

    expect(names(content)).toEqual([
      'agentpress-article-outcome',
      'agentpress-run-part',
      'agentpress-run-part',
      'agentpress-run-part',
    ]);
    expect(JSON.stringify(content)).not.toContain('artifact-2');
    expect(JSON.stringify(content)).toContain('artifact-3');
    expect(JSON.stringify(content)).toContain('artifact-4');
    expect(JSON.stringify(content)).toContain('artifact-5');
  });

  it('filters matching artifacts inside an aggregate without removing other deliverables', () => {
    const content = projectionContent(
      projection([
        articleChange('proposal-1', 1),
        part('artifact', 'artifact.available', 2, {
          artifacts: [
            artifactPayload('EditProposal', 'proposal-1', 'matching'),
            artifactPayload('EditProposal', 'proposal-2', 'other-proposal'),
            artifactPayload('ArticleDraft', undefined, 'draft'),
          ],
        }),
      ]),
    );

    expect(JSON.stringify(content)).not.toContain('matching');
    expect(JSON.stringify(content)).toContain('other-proposal');
    expect(JSON.stringify(content)).toContain('draft');
  });

  it('keeps an ordinary answer with a separately disclosed reasoning summary', () => {
    const content = projectionContent(
      projection([
        part('context', 'context.ready', 1, { revisionId: 'revision-secret' }),
        part('reasoning', 'reasoning.completed', 2, { text: 'internal analysis' }),
        part('plan', 'plan.created', 3, { steps: [] }),
        text('这是普通回答。', 4),
        usage(5),
      ]),
    );

    expect(texts(content)).toEqual(['这是普通回答。']);
    expect(names(content)).toEqual(['agentpress-run-process']);
  });

  it('keeps warnings visible before the stable process status', () => {
    const content = projectionContent(
      projection([part('warning', 'run.failed', 2, {})], false, 'running'),
    );

    expect(content[0]).toMatchObject({ type: 'data', name: 'agentpress-run-part' });
    expect(content[1]).toMatchObject({ type: 'data', name: 'agentpress-run-process' });
  });

  it('does not duplicate planning as a synthetic process status', () => {
    const content = projectionContent(
      projection([part('reasoning', 'run.planning', 1, {})], false, 'planning'),
    );
    expect(names(content)).toEqual(['agentpress-run-process']);
  });

  it('keeps the process position stable across terminal state changes', () => {
    const running = projectionContent(
      projection(
        [
          text('处理中。', 1),
          part('activity', 'tool.executing', 2, {
            toolId: 'article.read_current',
            toolCallId: 'call-1',
          }),
        ],
        false,
        'running',
      ),
    );
    const terminal = projectionContent(
      projection(
        [
          text('已完成。', 1),
          part('activity', 'tool.succeeded', 2, {
            toolId: 'article.read_current',
            toolCallId: 'call-1',
          }),
        ],
        true,
        'completed',
      ),
    );
    expect(names(running)).toEqual(['agentpress-run-process']);
    expect(names(terminal)).toEqual(['agentpress-run-process']);
    expect(texts(running)).toEqual(['处理中。']);
    expect(texts(terminal)).toEqual(['已完成。']);
    if (typeof running !== 'string' && typeof terminal !== 'string') {
      expect(running.map(({ type }) => type)).toEqual(['text', 'data']);
      expect(terminal.map(({ type }) => type)).toEqual(['text', 'data']);
    }
  });

  it('adds one terminal process only for consumer-relevant activity', () => {
    const content = projectionContent(
      projection([
        text('资料已经整理好。', 1),
        part('activity', 'tool.succeeded', 2, {
          toolId: 'web.search',
          toolCallId: 'call-1',
        }),
        usage(3),
      ]),
    );

    expect(names(content)).toEqual(['agentpress-run-process']);
    const process = dataByName(content, 'agentpress-run-process');
    expect((process.parts as RunPart[]).map(({ type }) => type)).toEqual(['activity', 'usage']);
    expect(process).toMatchObject({ durationMs: 19_000 });
  });

  it('preserves utility-pipeline-utility order and pipeline result facts', () => {
    const content = projectionContent(
      projection([
        part('activity', 'tool.succeeded', 1, {
          toolId: 'article.read_current',
          toolCallId: 'read-1',
        }),
        part('activity', 'tool.succeeded', 2, {
          toolId: 'article.propose_edits',
          toolCallId: 'edit-1',
          output: { summary: '已生成两处修改' },
        }),
        part('activity', 'tool.succeeded', 3, { toolId: 'web.search', toolCallId: 'search-1' }),
        usage(4),
      ]),
    );
    const process = dataByName(content, 'agentpress-run-process');
    expect(process.items).toMatchObject([
      { kind: 'utility-group', count: 1 },
      {
        kind: 'pipeline',
        label: '生成修改稿',
        status: 'completed',
        result: { summary: '已生成两处修改' },
      },
      { kind: 'utility-group', count: 1 },
    ]);
  });

  it('keeps failed tool activity outside the collapsed process', () => {
    const content = projectionContent(
      projection(
        [
          part('activity', 'tool.failed', 1, {
            toolId: 'web.search',
            toolCallId: 'call-1',
          }),
          part('warning', 'run.failed', 2, {}),
          usage(3),
        ],
        true,
        'failed',
      ),
    );

    expect(names(content)).toEqual([
      'agentpress-run-part',
      'agentpress-run-part',
      'agentpress-run-process',
    ]);
    expect(JSON.stringify(content)).toContain('call-1');
  });

  it('uses a consumer task label and suppresses an orphaned started task after failure', () => {
    const content = projectionContent(
      projection(
        [
          part('plan', 'plan.revised', 1, {
            tasks: [
              { id: 'task-1', owner: 'editor', objective: 'article UUID and SHA-256 secret' },
            ],
          }),
          part('activity', 'task.started', 2, {
            taskId: 'task-1',
            owner: 'editor',
            objective: 'article UUID and SHA-256 secret',
          }),
          part('warning', 'run.failed', 3, { error: { code: 'runtime_error' } }),
        ],
        true,
        'failed',
      ),
    );
    expect(JSON.stringify(content)).not.toContain('article UUID');
    expect(JSON.stringify(content)).not.toContain('SHA-256');
    expect(JSON.stringify(content)).toContain('task-1');
    expect(names(content)).toEqual(['agentpress-run-part', 'agentpress-run-process']);
  });

  it('preserves typed timeout, cancellation, interruption, stale and degraded stage outcomes', () => {
    const activity = part('activity', 'task.succeeded', 1, {
      taskId: 'task-typed-outcomes',
      lifecycleStages: [
        { status: 'task.timed_out' },
        { status: 'task.cancelled' },
        { status: 'task.interrupted' },
        { status: 'task.stale' },
        { status: 'task.degraded' },
      ],
    });
    const [item] = executionItems([activity], [activity]);
    expect(item).toMatchObject({
      kind: 'pipeline',
      status: 'completed',
      stages: [
        { status: 'timed_out', label: '已超时' },
        { status: 'cancelled', label: '已取消' },
        { status: 'interrupted', label: '已中断' },
        { status: 'stale', label: '已过期' },
        { status: 'degraded', label: '部分完成' },
      ],
    });
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

function artifact(type: string, targetId: string | undefined, sequence: number): RunPart {
  return part(
    'artifact',
    'artifact.available',
    sequence,
    artifactPayload(type, targetId, `artifact-${String(sequence)}`),
  );
}

function artifactPayload(
  type: string,
  targetId: string | undefined,
  id: string,
): Readonly<Record<string, unknown>> {
  return {
    id,
    type,
    title: id,
    ...(targetId
      ? {
          presentation: {
            kind: 'outcome_artifact',
            targetType: 'article-change',
            targetId,
          },
        }
      : {}),
  };
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

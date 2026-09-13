import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AgentArticleChangePart } from './agent-article-change-part';
import { RunActionsContext } from './agent-run-actions';

describe('Agent article change part', () => {
  it('renders a link to the persisted working draft', () => {
    const openArticleProposal = vi.fn(() => Promise.resolve());
    const markup = renderToStaticMarkup(
      <RunActionsContext.Provider
        value={{
          decideTool: () => Promise.resolve(),
          answerQuestion: () => Promise.resolve(),
          decideActionProposal: () => Promise.resolve({}),
          openArticleProposal,
        }}
      >
        <AgentArticleChangePart
          part={{
            id: 'part-1',
            runId: 'run-1',
            sequence: 1,
            type: 'article-change',
            status: 'article-change.pending',
            payload: {
              proposalStatus: 'pending',
              proposalId: 'proposal-1',
              reviewMode: 'document',
              operations: [{ operationId: 'operation-1', kind: 'replace', blockId: 'block-1' }],
              diffs: [{ operationId: 'operation-1', kind: 'replace', blockId: 'block-1' }],
            },
          }}
        />
      </RunActionsContext.Provider>,
    );
    expect(markup).toContain('在正文中审阅');
    expect(markup).toContain('整篇文章草稿');
  });

  it('keeps a settled historical change visible without treating it as a pending draft', () => {
    const markup = renderToStaticMarkup(
      <RunActionsContext.Provider
        value={{
          decideTool: () => Promise.resolve(),
          answerQuestion: () => Promise.resolve(),
          decideActionProposal: () => Promise.resolve({}),
          openArticleProposal: () => Promise.resolve(),
        }}
      >
        <AgentArticleChangePart
          part={{
            id: 'part-1',
            runId: 'run-1',
            sequence: 1,
            type: 'article-change',
            status: 'article.proposal.created',
            payload: {
              proposalStatus: 'rejected',
              proposalId: 'proposal-1',
              operations: [{ operationId: 'operation-1', kind: 'replace', blockId: 'block-1' }],
              diffs: [{ operationId: 'operation-1', kind: 'replace', blockId: 'block-1' }],
            },
          }}
        />
      </RunActionsContext.Provider>,
    );

    expect(markup).toContain('已拒绝');
    expect(markup).toContain('在正文中审阅');
    expect(markup).not.toContain('正文工作草稿');
  });

  it('combines a structured outcome receipt with one collapsed process disclosure', () => {
    const markup = renderToStaticMarkup(
      <RunActionsContext.Provider
        value={{
          decideTool: () => Promise.resolve(),
          answerQuestion: () => Promise.resolve(),
          decideActionProposal: () => Promise.resolve({}),
          openArticleProposal: () => Promise.resolve(),
        }}
      >
        <AgentArticleChangePart
          part={{
            id: 'part-1',
            runId: 'run-1',
            sequence: 1,
            type: 'article-change',
            status: 'article.proposal.created',
            payload: {
              proposalStatus: 'pending',
              proposalId: 'proposal-1',
              operations: [{ operationId: 'operation-1' }],
              diffs: [],
            },
          }}
          process={{
            runId: 'run-1',
            status: 'completed',
            terminal: true,
            durationMs: 19_000,
            parts: [
              {
                id: 'activity-1',
                runId: 'run-1',
                sequence: 2,
                type: 'activity',
                status: 'tool.succeeded',
                payload: { toolId: 'article.propose_edits', toolCallId: 'call-1' },
              },
            ],
          }}
        />
      </RunActionsContext.Provider>,
    );

    expect(markup).toContain('已生成 1 处修改');
    expect(markup).toContain('19 秒');
    expect(markup).toContain('在正文中审阅');
    expect(markup).toContain('过程详情');
    expect(markup).not.toContain('<details open');
  });

  it('distinguishes current-run changes from the accumulated working draft', () => {
    const markup = renderToStaticMarkup(
      <RunActionsContext.Provider
        value={{
          decideTool: () => Promise.resolve(),
          answerQuestion: () => Promise.resolve(),
          decideActionProposal: () => Promise.resolve({}),
        }}
      >
        <AgentArticleChangePart
          part={{
            id: 'part-1',
            runId: 'run-current',
            sequence: 1,
            type: 'article-change',
            status: 'article.proposal.created',
            payload: {
              proposalStatus: 'pending',
              proposalId: 'proposal-1',
              operations: Array.from({ length: 8 }, (_, index) => ({
                operationId: `operation-${String(index + 1)}`,
              })),
              diffs: [],
              batches: [
                {
                  id: 'batch-1',
                  runId: 'run-previous',
                  batchNumber: 1,
                  operationCount: 4,
                  status: 'active',
                },
                {
                  id: 'batch-2',
                  runId: 'run-current',
                  batchNumber: 2,
                  operationCount: 4,
                  status: 'active',
                },
              ],
            },
          }}
        />
      </RunActionsContext.Provider>,
    );

    expect(markup).toContain('本次新增 4 处修改，当前共 8 处待审');
    expect(markup).not.toContain('已生成 8 处修改');
  });
});

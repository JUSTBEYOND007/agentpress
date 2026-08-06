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
    expect(markup).toContain('执行过程');
    expect(markup).not.toContain('<details open');
  });
});

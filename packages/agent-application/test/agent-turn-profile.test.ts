import type { RuntimeCurrentTurn } from '@agentpress/agent-runtime';
import { describe, expect, it } from 'vitest';

import { createAgentTurnProfile, selectMainControlTools } from '../src/agent-turn-profile.js';

function freeTextTurn(
  included: readonly Readonly<Record<string, unknown>>[] = [],
): RuntimeCurrentTurn {
  return {
    type: 'agentpress_current_turn',
    version: 1,
    source: 'user',
    request: '你好',
    actionEnvelope: { version: 1, source: 'free_text', grantedCapabilities: [] },
    context: {
      content: '',
      contentHash: 'hash',
      format: 'json',
      schemaVersion: 1,
      manifest: { included },
    },
    timestamp: 1,
  };
}

describe('AgentTurnProfile', () => {
  it('keeps ordinary conversation free of article mutation controls', () => {
    const profile = createAgentTurnProfile(freeTextTurn(), ['web.research']);
    expect(profile).toMatchObject({
      kind: 'conversation_chat',
      sessionKind: 'conversation',
      controlToolNames: ['plan_submit', 'user_request_input'],
    });
  });

  it('exposes the exact free-text article control table', () => {
    const profile = createAgentTurnProfile(
      freeTextTurn([{ id: 'article:article-id', kind: 'mention' }]),
      ['article.read', 'web.research'],
    );
    expect(
      selectMainControlTools(profile, [
        { name: 'action_propose' },
        { name: 'conversation_title_set' },
        { name: 'plan_submit' },
        { name: 'user_request_input' },
      ]).map(({ name }) => name),
    ).toEqual(['action_propose', 'plan_submit', 'user_request_input']);
  });

  it('turns a confirmed edit into a deterministic no-control profile', () => {
    const turn: RuntimeCurrentTurn = {
      ...freeTextTurn(),
      request: '继续上一段',
      actionEnvelope: {
        version: 1,
        source: 'button',
        requestedIntent: 'article_edit',
        actionProposalId: '4f1be6d3-99d9-4719-8219-5dd7754a8496',
        payload: {
          instruction: '继续上一段',
          articleId: 'bb09dcbc-7f12-4d3e-bd93-d975d1f16e7f',
          baseRevisionId: '5724b935-c5c8-4a04-8155-50d911cf60ae',
          selectedBlocks: [],
        },
        grantedCapabilities: ['article.read', 'article.propose'],
      },
    };
    expect(createAgentTurnProfile(turn, ['article.propose'])).toMatchObject({
      kind: 'confirmed_article_edit',
      allowedCapabilities: ['article.propose'],
      controlToolNames: [],
    });
  });
});

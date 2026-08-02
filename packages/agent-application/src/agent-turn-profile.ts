import type { RuntimeCurrentTurn } from '@agentpress/agent-runtime';

export type AgentTurnKind = 'conversation_chat' | 'article_chat' | 'confirmed_article_edit';
export type MainControlToolName = 'action_propose' | 'plan_submit' | 'user_request_input';

export type AgentTurnProfile = {
  readonly kind: AgentTurnKind;
  readonly sessionKind: 'conversation' | 'article';
  readonly actionSource: RuntimeCurrentTurn['actionEnvelope']['source'];
  readonly requestedIntent?: 'article_edit';
  readonly hasArticleContext: boolean;
  readonly allowedCapabilities: readonly string[];
  readonly controlToolNames: readonly MainControlToolName[];
};

export function createAgentTurnProfile(
  turn: RuntimeCurrentTurn,
  availableCapabilities: readonly string[],
): AgentTurnProfile {
  const hasArticleContext = contextIncludesArticle(turn);
  if (
    turn.actionEnvelope.source === 'button' &&
    turn.actionEnvelope.requestedIntent === 'article_edit'
  ) {
    const available = new Set(availableCapabilities);
    return {
      kind: 'confirmed_article_edit',
      sessionKind: 'article',
      actionSource: 'button',
      requestedIntent: 'article_edit',
      hasArticleContext: true,
      allowedCapabilities: turn.actionEnvelope.grantedCapabilities.filter((capability) =>
        available.has(capability),
      ),
      controlToolNames: [],
    };
  }

  return {
    kind: hasArticleContext ? 'article_chat' : 'conversation_chat',
    sessionKind: hasArticleContext ? 'article' : 'conversation',
    actionSource: 'free_text',
    hasArticleContext,
    allowedCapabilities: availableCapabilities,
    controlToolNames: [
      ...(hasArticleContext ? (['action_propose'] as const) : []),
      'plan_submit',
      'user_request_input',
    ],
  };
}

export function selectMainControlTools<T extends { readonly name: string }>(
  profile: AgentTurnProfile,
  tools: readonly T[],
): readonly T[] {
  const allowed = new Set<string>(profile.controlToolNames);
  return tools.filter(({ name }) => allowed.has(name));
}

function contextIncludesArticle(turn: RuntimeCurrentTurn): boolean {
  const included = turn.context?.manifest.included;
  return (
    Array.isArray(included) &&
    included.some(
      (candidate) =>
        isRecord(candidate) &&
        candidate.kind === 'mention' &&
        typeof candidate.id === 'string' &&
        (candidate.id.startsWith('article:') || candidate.id.startsWith('article-selection:')),
    )
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

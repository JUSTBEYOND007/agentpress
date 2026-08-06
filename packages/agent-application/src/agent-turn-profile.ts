import { createHash } from 'node:crypto';
import type { RuntimeCurrentTurn } from '@agentpress/agent-runtime';

export type AgentTurnKind = 'conversation_chat' | 'article_agent' | 'confirmed_article_edit';
export type MainControlToolName = 'action_propose' | 'plan_submit' | 'user_request_input';

export type AgentTurnProfile = {
  readonly kind: AgentTurnKind;
  readonly sessionKind: 'conversation' | 'article';
  readonly turnSource: RuntimeCurrentTurn['source'];
  readonly actionSource: RuntimeCurrentTurn['actionEnvelope']['source'];
  readonly requestedIntent?: 'article_edit';
  readonly hasArticleContext: boolean;
  readonly articleBinding?: { readonly id: string; readonly revision?: string };
  readonly permissionSnapshot: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly controlToolNames: readonly MainControlToolName[];
  readonly profileHash: string;
};

export function createAgentTurnProfile(
  turn: RuntimeCurrentTurn,
  availableCapabilities: readonly string[],
): AgentTurnProfile {
  const articleBinding = articleContextBinding(turn);
  const hasArticleContext = articleBinding !== undefined;
  if (
    turn.actionEnvelope.source === 'button' &&
    turn.actionEnvelope.requestedIntent === 'article_edit'
  ) {
    const available = new Set(availableCapabilities);
    return withProfileHash({
      kind: 'confirmed_article_edit',
      sessionKind: 'article',
      turnSource: turn.source,
      actionSource: 'button',
      requestedIntent: 'article_edit',
      hasArticleContext: true,
      ...(articleBinding ? { articleBinding } : {}),
      permissionSnapshot: [...turn.actionEnvelope.grantedCapabilities].sort(),
      allowedCapabilities: turn.actionEnvelope.grantedCapabilities.filter((capability) =>
        available.has(capability),
      ),
      controlToolNames: [],
    });
  }

  const permissions = [...availableCapabilities].sort();
  return withProfileHash({
    kind: hasArticleContext ? 'article_agent' : 'conversation_chat',
    sessionKind: hasArticleContext ? 'article' : 'conversation',
    turnSource: turn.source,
    actionSource: 'free_text',
    hasArticleContext,
    ...(articleBinding ? { articleBinding } : {}),
    permissionSnapshot: permissions,
    allowedCapabilities: availableCapabilities,
    controlToolNames: ['plan_submit', 'user_request_input'],
  });
}

export function selectMainControlTools<T extends { readonly name: string }>(
  profile: AgentTurnProfile,
  tools: readonly T[],
): readonly T[] {
  const allowed = new Set<string>(profile.controlToolNames);
  return tools.filter(({ name }) => allowed.has(name));
}

function articleContextBinding(
  turn: RuntimeCurrentTurn,
): { readonly id: string; readonly revision?: string } | undefined {
  const included: unknown = turn.context?.manifest.included;
  if (!Array.isArray(included)) return undefined;
  const candidates = included as readonly unknown[];
  const candidate: unknown = candidates.find(
    (item) =>
      isRecord(item) &&
      item.kind === 'mention' &&
      typeof item.id === 'string' &&
      (item.id.startsWith('article:') || item.id.startsWith('article-selection:')),
  );
  if (!isRecord(candidate) || typeof candidate.id !== 'string') return undefined;
  return {
    id: candidate.id,
    ...(typeof candidate.revision === 'string' ? { revision: candidate.revision } : {}),
  };
}

function withProfileHash(profile: Omit<AgentTurnProfile, 'profileHash'>): AgentTurnProfile {
  return {
    ...profile,
    profileHash: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

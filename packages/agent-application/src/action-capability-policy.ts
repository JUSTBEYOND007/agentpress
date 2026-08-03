import type { ActionEnvelopeV1 } from '@agentpress/contracts';

export const ARTICLE_PROPOSE_CAPABILITY = 'article.propose';

export function effectiveActionCapabilities(
  envelope: ActionEnvelopeV1,
  availableCapabilities: Iterable<string>,
  policy: { readonly allowArticleDraftWrite?: boolean } = {},
): ReadonlySet<string> {
  const available = new Set(availableCapabilities);
  if (envelope.source === 'free_text') {
    if (policy.allowArticleDraftWrite !== true) available.delete(ARTICLE_PROPOSE_CAPABILITY);
    return available;
  }

  const grants = new Set(envelope.grantedCapabilities);
  return new Set([...available].filter((capability) => grants.has(capability)));
}

export function actionAllowsCapability(
  envelope: ActionEnvelopeV1,
  capability: string,
  availableCapabilities: Iterable<string>,
): boolean {
  return effectiveActionCapabilities(envelope, availableCapabilities).has(capability);
}

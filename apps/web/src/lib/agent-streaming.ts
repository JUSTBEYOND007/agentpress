export type LiveRunContent = { readonly runId: string; readonly text: string };

export function updateLiveRunContent(
  current: readonly LiveRunContent[],
  input: {
    readonly runId: string;
    readonly mode: 'direct' | 'planned';
    readonly eventType: string;
    readonly delta?: string;
  },
): readonly LiveRunContent[] {
  if (input.eventType === 'content.delta') {
    if (input.mode === 'planned' || !input.delta) return current;
    const existing = current.find(({ runId }) => runId === input.runId);
    const next = existing
      ? { runId: input.runId, text: `${existing.text}${input.delta}` }
      : { runId: input.runId, text: input.delta };
    return [...current.filter(({ runId }) => runId !== input.runId), next];
  }
  if (input.eventType === 'message.started' || input.eventType === 'turn.started') {
    return clearLiveRunContent(current, input.runId);
  }
  return current;
}

export function clearLiveRunContent(
  current: readonly LiveRunContent[],
  runId: string,
): readonly LiveRunContent[] {
  return current.filter(({ runId: id }) => id !== runId);
}

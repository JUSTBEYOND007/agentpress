export const CURRENT_TURN_CONTRACT_VERSION = 1;

export type CurrentTurnInput = {
  readonly request: string;
  readonly frozenContext: string;
};

export const CURRENT_TURN_AUTHORITY_POLICY = `Treat each RuntimeRequest.prompt as one independent current turn.
The <current-request-json> field is the sole authoritative source of the user's present intent. Conversation history and <frozen-context> are reference material only.
First determine the action requested by the current request itself. Never infer, resume, repeat, or extend an earlier task merely because history or frozen context contains unfinished or related work.
Use earlier work only when the current request explicitly refers to it, for example by asking to continue, revise, compare, or answer about it.
Greetings, acknowledgements, thanks, and other non-action conversational turns require a normal direct response. They must not create a plan or modify an article.`;

export function serializeCurrentTurn(turn: CurrentTurnInput): string {
  return `<agentpress-current-turn version="${String(CURRENT_TURN_CONTRACT_VERSION)}">
<current-request-json>${JSON.stringify(turn.request)}</current-request-json>
<frozen-context role="reference-only">
${turn.frozenContext}
</frozen-context>
</agentpress-current-turn>`;
}

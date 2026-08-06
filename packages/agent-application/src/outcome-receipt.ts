import type { RuntimeAssistantMessage } from '@agentpress/agent-runtime';

type OutcomeReceipt = NonNullable<RuntimeAssistantMessage['presentation']>;

export function articleOutcomeReceipt(targetId: string): OutcomeReceipt {
  return { kind: 'outcome_receipt', targetType: 'article-change', targetId };
}

export function articleOutcomeReceiptFromArtifact(
  artifact:
    | {
        readonly type: string;
        readonly content: Readonly<Record<string, unknown>>;
      }
    | undefined,
): OutcomeReceipt | undefined {
  if (artifact?.type !== 'EditProposal') return undefined;
  const proposalId = artifact.content.proposalId;
  return typeof proposalId === 'string' && proposalId.length > 0
    ? articleOutcomeReceipt(proposalId)
    : undefined;
}

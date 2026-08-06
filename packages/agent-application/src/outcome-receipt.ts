import type { RuntimeAssistantMessage, RuntimeResult } from '@agentpress/agent-runtime';

type OutcomeReceipt = NonNullable<RuntimeAssistantMessage['presentation']>;

export type OutcomeArtifactPresentation = {
  readonly kind: 'outcome_artifact';
  readonly targetType: 'article-change';
  readonly targetId: string;
};

type StructuredArtifact = {
  readonly type: string;
  readonly content: Readonly<Record<string, unknown>>;
};

export function articleOutcomeReceipt(targetId: string): OutcomeReceipt {
  return { kind: 'outcome_receipt', targetType: 'article-change', targetId };
}

export function articleOutcomeReceiptFromArtifact(
  artifact: StructuredArtifact | undefined,
): OutcomeReceipt | undefined {
  if (artifact?.type !== 'EditProposal') return undefined;
  const proposalId = artifact.content.proposalId;
  return typeof proposalId === 'string' && proposalId.length > 0
    ? articleOutcomeReceipt(proposalId)
    : undefined;
}

export function articleOutcomeArtifactPresentation(
  artifact: StructuredArtifact | undefined,
): OutcomeArtifactPresentation | undefined {
  const receipt = articleOutcomeReceiptFromArtifact(artifact);
  return receipt
    ? { kind: 'outcome_artifact', targetType: receipt.targetType, targetId: receipt.targetId }
    : undefined;
}

export function withArticleOutcomeReceipt(
  result: RuntimeResult,
  artifacts: readonly StructuredArtifact[],
): RuntimeResult {
  if (result.status !== 'completed') return result;
  const targetIds = new Set(
    artifacts.flatMap((artifact) => {
      const presentation = articleOutcomeReceiptFromArtifact(artifact);
      return presentation ? [presentation.targetId] : [];
    }),
  );
  if (targetIds.size !== 1) return result;
  const targetId = [...targetIds][0];
  if (!targetId) return result;

  let assistantIndex = -1;
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    if (result.messages[index]?.role === 'assistant') {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return result;
  return {
    ...result,
    messages: result.messages.map((message, index) =>
      index === assistantIndex && message.role === 'assistant'
        ? { ...message, presentation: articleOutcomeReceipt(targetId) }
        : message,
    ),
  };
}

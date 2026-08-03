'use client';

import { createContext, useContext } from 'react';

import type { Proposal } from './agent-view-model';

export type RunActions = {
  readonly decideTool: (toolCallId: string, decision: 'approved' | 'denied') => Promise<void>;
  readonly answerQuestion: (runId: string, questionId: string, answer: string) => Promise<void>;
  readonly decideActionProposal: (
    proposalId: string,
    decision: 'confirmed' | 'rejected',
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly openArticleProposal?: (proposal: Proposal) => Promise<void>;
};

export const RunActionsContext = createContext<RunActions | undefined>(undefined);

export function useRunActions(): RunActions {
  const actions = useContext(RunActionsContext);
  if (!actions) throw new Error('Run actions are unavailable');
  return actions;
}

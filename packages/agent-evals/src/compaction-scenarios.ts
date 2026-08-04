import type { ConversationSummaryMessage } from '@agentpress/agent-application';

export const COMPACTION_EVAL_DATASET_VERSION = 'agentpress-compaction-v1' as const;

export const COMPACTION_EVAL_REQUIREMENTS = [
  'fact_retention',
  'user_intent',
  'unfinished_action',
  'citation',
  'branch_isolation',
  'stale_state',
] as const;

export type CompactionEvalRequirement = (typeof COMPACTION_EVAL_REQUIREMENTS)[number];

export type CompactionEvalCase = {
  readonly id: string;
  readonly requirements: readonly CompactionEvalRequirement[];
  readonly previousSummary?: string;
  readonly messages: readonly ConversationSummaryMessage[];
  readonly preserveData: Readonly<Record<string, unknown>>;
  readonly requiredReferences: readonly string[];
  readonly forbiddenReferences?: readonly string[];
  readonly requiredSemantics: readonly {
    readonly label: string;
    readonly patterns: readonly string[];
  }[];
};

export type CompactionSummaryScore = {
  readonly passed: boolean;
  readonly requiredFacts: number;
  readonly retainedFacts: number;
  readonly factRetention: number;
  readonly missingReferences: readonly string[];
  readonly forbiddenReferences: readonly string[];
  readonly missingSemantics: readonly string[];
};

export const compactionEvalCases: readonly CompactionEvalCase[] = [
  {
    id: 'intent-and-unsettled-action',
    requirements: ['fact_retention', 'user_intent', 'unfinished_action'],
    messages: [
      message(1, 'user', 'FACT-USER-GOAL-731: prepare a sourced launch brief.'),
      message(2, 'assistant', 'EVID-ALPHA-732 supports the market-size claim.'),
      message(
        3,
        'user',
        'FACT-NO-PUBLISH-733: do not publish. TOOL-PENDING-734 is still awaiting approval.',
      ),
      message(4, 'assistant', 'The draft remains pending and has not been published.'),
    ],
    preserveData: {
      evidenceIds: ['EVID-ALPHA-732'],
      unsettledToolCallIds: ['TOOL-PENDING-734'],
    },
    requiredReferences: ['EVID-ALPHA-732', 'TOOL-PENDING-734'],
    requiredSemantics: [
      { label: 'launch brief intent', patterns: ['prepare a sourced launch brief'] },
      { label: 'publication prohibition', patterns: ['do not publish'] },
    ],
  },
  {
    id: 'incremental-stale-state',
    requirements: ['fact_retention', 'stale_state'],
    previousSummary:
      'STATE-DRAFT-PENDING-810: the draft awaited review. EVID-BETA-811 was the cited source.',
    messages: [
      message(
        5,
        'user',
        'STATE-DRAFT-REJECTED-812 supersedes the pending state; retain the decision history and do not call it approved.',
      ),
      message(6, 'assistant', 'The rejection is recorded and no mutation will run.'),
    ],
    preserveData: {
      evidenceIds: ['EVID-BETA-811'],
      stateReferences: ['STATE-DRAFT-PENDING-810', 'STATE-DRAFT-REJECTED-812'],
    },
    requiredReferences: ['STATE-DRAFT-PENDING-810', 'EVID-BETA-811', 'STATE-DRAFT-REJECTED-812'],
    requiredSemantics: [
      { label: 'rejected current state', patterns: ['draft.{0,30}reject'] },
      {
        label: 'not approved constraint',
        patterns: ['(?:must not|do not).{0,40}approved'],
      },
    ],
  },
  {
    id: 'citation-and-unknown',
    requirements: ['fact_retention', 'citation'],
    messages: [
      message(1, 'user', 'CLAIM-UNKNOWN-901 has no verified answer yet.'),
      message(
        2,
        'assistant',
        'EVID-GAMMA-902 verifies only the publication date, not CLAIM-UNKNOWN-901.',
      ),
      message(3, 'user', 'Keep the unknown explicit and preserve citation EVID-GAMMA-902.'),
      message(4, 'assistant', 'No unsupported answer was inferred.'),
    ],
    preserveData: { evidenceIds: ['EVID-GAMMA-902'] },
    requiredReferences: ['CLAIM-UNKNOWN-901', 'EVID-GAMMA-902'],
    requiredSemantics: [
      { label: 'unknown remains explicit', patterns: ['has no verified answer'] },
    ],
  },
  {
    id: 'sibling-branch-isolation',
    requirements: ['fact_retention', 'branch_isolation'],
    messages: [
      message(1, 'user', 'BRANCH-A-GOAL-920: prepare the public launch timeline.'),
      message(2, 'assistant', 'EVID-BRANCH-A-921 supports the timeline.'),
      message(3, 'user', 'Keep this branch scoped to the public launch only.'),
    ],
    preserveData: {
      branchId: 'BRANCH-A',
      evidenceIds: ['EVID-BRANCH-A-921'],
    },
    requiredReferences: ['BRANCH-A-GOAL-920', 'EVID-BRANCH-A-921'],
    forbiddenReferences: ['BRANCH-B-SECRET-922'],
    requiredSemantics: [{ label: 'public launch branch scope', patterns: ['public launch'] }],
  },
];

export function scoreCompactionSummary(
  scenario: CompactionEvalCase,
  summary: string,
): CompactionSummaryScore {
  const missingReferences = scenario.requiredReferences.filter(
    (reference) => !summary.includes(reference),
  );
  const forbiddenReferences = (scenario.forbiddenReferences ?? []).filter((reference) =>
    summary.includes(reference),
  );
  const normalizedSummary = summary.toLocaleLowerCase('en-US');
  const missingSemantics = scenario.requiredSemantics
    .filter(
      ({ patterns }) =>
        !patterns.some((pattern) => new RegExp(pattern, 'iu').test(normalizedSummary)),
    )
    .map(({ label }) => label);
  const requiredFacts = scenario.requiredReferences.length + scenario.requiredSemantics.length;
  const retainedFacts = requiredFacts - missingReferences.length - missingSemantics.length;
  return {
    passed:
      missingReferences.length === 0 &&
      forbiddenReferences.length === 0 &&
      missingSemantics.length === 0,
    requiredFacts,
    retainedFacts,
    factRetention: requiredFacts === 0 ? 1 : retainedFacts / requiredFacts,
    missingReferences,
    forbiddenReferences,
    missingSemantics,
  };
}

function message(
  sequence: number,
  role: ConversationSummaryMessage['role'],
  content: string,
): ConversationSummaryMessage {
  return { sequence, role, content };
}

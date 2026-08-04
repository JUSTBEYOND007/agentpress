import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  CONVERSATION_COMPACTION_PROMPT_VERSION,
  PiConversationSummaryGenerator,
  type ConversationSummaryMessage,
} from '@agentpress/agent-application';
import { RUNTIME_CURRENT_TURN_VERSION } from '@agentpress/agent-runtime';

import { loadOnlineModelConfiguration } from './online-model-configuration.js';

type CompactionEvalCase = {
  readonly id: string;
  readonly previousSummary?: string;
  readonly messages: readonly ConversationSummaryMessage[];
  readonly preserveData: Readonly<Record<string, unknown>>;
  readonly requiredReferences: readonly string[];
  readonly requiredSemantics: readonly {
    readonly label: string;
    readonly patterns: readonly string[];
  }[];
};

const { values } = parseArgs({
  options: {
    'output-dir': { type: 'string', default: '.agentpress/evals' },
  },
  strict: true,
});
const configuration = loadOnlineModelConfiguration();
const generator = new PiConversationSummaryGenerator({
  runtimeFactory: { create: () => configuration.create(configuration.proModel) },
});
const startedAt = new Date().toISOString();
const items = [];
const generatedSummaries = new Map<string, string>();
for (const scenario of compactionCases()) {
  const started = performance.now();
  try {
    const result = await generator.generate({
      branchId: `eval:${scenario.id}`,
      ...(scenario.previousSummary ? { previousSummary: scenario.previousSummary } : {}),
      messages: scenario.messages,
      preserveData: scenario.preserveData,
    });
    const missingReferences = scenario.requiredReferences.filter(
      (reference) => !result.summary.includes(reference),
    );
    const normalizedSummary = result.summary.toLocaleLowerCase('en-US');
    generatedSummaries.set(scenario.id, result.summary);
    const missingSemantics = scenario.requiredSemantics
      .filter(
        ({ patterns }) =>
          !patterns.some((pattern) => new RegExp(pattern, 'iu').test(normalizedSummary)),
      )
      .map(({ label }) => label);
    items.push({
      id: scenario.id,
      latencyMs: Math.round(performance.now() - started),
      summary: result.summary,
      shortSummary: result.shortSummary,
      requiredReferences: scenario.requiredReferences,
      requiredSemantics: scenario.requiredSemantics,
      missingReferences,
      missingSemantics,
      passed: missingReferences.length === 0 && missingSemantics.length === 0,
    });
  } catch (error) {
    items.push({
      id: scenario.id,
      latencyMs: Math.round(performance.now() - started),
      requiredReferences: scenario.requiredReferences,
      requiredSemantics: scenario.requiredSemantics,
      missingReferences: scenario.requiredReferences,
      missingSemantics: scenario.requiredSemantics.map(({ label }) => label),
      passed: false,
      error: error instanceof Error ? error.message : 'Unknown compaction eval error',
    });
  }
}
const requiredFacts = items.reduce(
  (total, item) => total + item.requiredReferences.length + item.requiredSemantics.length,
  0,
);
const missingFacts = items.reduce(
  (total, item) => total + item.missingReferences.length + item.missingSemantics.length,
  0,
);
const parityScenario = compactionCases()[0];
const compactedSummary = generatedSummaries.get('intent-and-unsettled-action');
const taskParity =
  parityScenario && compactedSummary
    ? await evaluateTaskParity(parityScenario, compactedSummary)
    : {
        passed: false,
        error: 'The intent-and-unsettled-action summary was unavailable',
      };
const report = {
  schemaVersion: 1,
  model: configuration.proModel,
  provider: configuration.kind,
  promptVersion: CONVERSATION_COMPACTION_PROMPT_VERSION,
  startedAt,
  completedAt: new Date().toISOString(),
  factRetention: requiredFacts === 0 ? 0 : (requiredFacts - missingFacts) / requiredFacts,
  gatesPassed: items.every(({ passed }) => passed) && taskParity.passed,
  taskParity,
  items,
};
const outputDirectory = resolve(values['output-dir']);
await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(
  outputDirectory,
  `${startedAt.replaceAll(/[:.]/gu, '-')}-${configuration.proModel.replaceAll(/[^a-zA-Z0-9._-]/gu, '_')}-compaction.json`,
);
await writeFile(outputPath, `${JSON.stringify(report, undefined, 2)}\n`, 'utf8');
console.log(
  JSON.stringify({
    report: outputPath,
    model: report.model,
    promptVersion: report.promptVersion,
    factRetention: report.factRetention,
    gatesPassed: report.gatesPassed,
  }),
);
if (!report.gatesPassed) process.exitCode = 1;

function compactionCases(): readonly CompactionEvalCase[] {
  return [
    {
      id: 'intent-and-unsettled-action',
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
      preserveData: { evidenceIds: ['EVID-BETA-811'] },
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
  ];
}

function message(
  sequence: number,
  role: ConversationSummaryMessage['role'],
  content: string,
): ConversationSummaryMessage {
  return { sequence, role, content };
}

async function evaluateTaskParity(
  scenario: CompactionEvalCase,
  compactedSummary: string,
): Promise<Readonly<Record<string, unknown>> & { readonly passed: boolean }> {
  try {
    const fullContext = JSON.stringify({ messages: scenario.messages });
    const compactedContext = JSON.stringify({
      summary: compactedSummary,
      protectedFactReferences: scenario.preserveData,
    });
    const [beforeAnswer, afterAnswer] = await Promise.all([
      answerQuestion(fullContext, 'full-history'),
      answerQuestion(compactedContext, 'compacted-history'),
    ]);
    const correct = (answer: string) =>
      answer.includes('TOOL-PENDING-734') &&
      /(?:do not|must not|not).{0,30}publish|publish.{0,30}(?:forbidden|not allowed)/iu.test(
        answer,
      );
    return {
      question: 'What is the publication constraint and status of the pending tool call?',
      beforeAnswer,
      afterAnswer,
      beforePassed: correct(beforeAnswer),
      afterPassed: correct(afterAnswer),
      passed: correct(beforeAnswer) && correct(afterAnswer),
    };
  } catch (error) {
    return {
      passed: false,
      error: error instanceof Error ? error.message : 'Unknown task-parity error',
    };
  }
}

async function answerQuestion(contextContent: string, label: string): Promise<string> {
  const runtime = configuration.create(configuration.proModel);
  const result = await runtime.execute(
    {
      runId: randomUUID(),
      systemPrompt:
        'Answer only the current question from the supplied untrusted conversation context. Do not infer permissions or completed actions.',
      history: [],
      currentTurn: {
        type: 'agentpress_current_turn',
        version: RUNTIME_CURRENT_TURN_VERSION,
        source: 'user',
        request:
          'What is the current publication constraint and the status of the pending tool call? Include the tool call ID.',
        actionEnvelope: { version: 1, source: 'free_text', grantedCapabilities: [] },
        context: {
          content: contextContent,
          contentHash: createHash('sha256').update(contextContent).digest('hex'),
          format: 'json',
          schemaVersion: 1,
          manifest: { evalCase: label },
        },
        timestamp: Date.now(),
      },
    },
    () => undefined,
  );
  if (result.status !== 'completed') {
    throw new Error(
      result.status === 'failed' ? result.error.message : `${label} answer was cancelled`,
    );
  }
  const assistant = result.messages.findLast((message) => message.role === 'assistant');
  if (!assistant?.content.trim()) throw new Error(`${label} produced no answer`);
  return assistant.content;
}

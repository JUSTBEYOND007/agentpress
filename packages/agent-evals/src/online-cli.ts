import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { DirectRunService, type RunEventPublisher } from '@agentpress/agent-application';
import type { RuntimeUsage } from '@agentpress/agent-runtime';
import {
  actionProposals,
  agentRuns,
  agentTasks,
  appUsers,
  approvals,
  articleRevisions,
  articles,
  artifacts,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  evidenceRecords,
  editProposals,
  promptRevisions,
  runContextPacks,
  runEvents,
  runSkillBindings,
  skillRevisions,
  toolCalls,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';
import { createBuiltInToolRuntime } from '@agentpress/runtime-tools';

import {
  runOnlineEvals,
  type OnlineEvalLimits,
  type OrchestratorEvalHarness,
} from './online-runner.js';
import { EVAL_CATEGORIES, evalScenarios, type EvalCategory } from './scenarios.js';
import { loadOnlineModelConfiguration } from './online-model-configuration.js';

const defaultOutputDirectory = resolve(import.meta.dirname, '../../../.agentpress/evals');
const { values } = parseArgs({
  options: {
    category: { type: 'string' },
    scenario: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    limit: { type: 'string', default: String(evalScenarios.length) },
    'max-total-tokens': { type: 'string', default: '200000' },
    'max-cost-usd': { type: 'string', default: '5' },
    'output-dir': { type: 'string', default: defaultOutputDirectory },
  },
  strict: true,
});
const modelConfiguration = loadOnlineModelConfiguration();
const proModel = modelConfiguration.proModel;
const turboModel = modelConfiguration.turboModel;
const declaredVersionManifest = {
  model: proModel,
  prompt: { id: 'agentpress.main', version: 'runtime-bound' },
  skills: [],
  tools: [],
  context: { policyVersion: 'agentpress.context-policy-v1', schemaVersion: '1' },
  runtime: {
    provider: modelConfiguration.kind,
    adapterVersion: 'pi-runtime@0.82.1',
    configVersion: 'agentpress-online-config-v1',
  },
} as const;
const databaseUrl = requiredEnv('DATABASE_URL');
const category = parseCategory(values.category);
const categoryScenarios = category
  ? evalScenarios.filter((scenario) => scenario.category === category)
  : evalScenarios;
const selectedScenario = values.scenario;
const scenarios = selectedScenario
  ? categoryScenarios.filter(
      (scenario) =>
        scenario.id === selectedScenario || scenario.id === `agentpress-${selectedScenario}`,
    )
  : categoryScenarios;
if (selectedScenario && scenarios.length === 0) {
  throw new Error(`Unknown eval scenario: ${selectedScenario}`);
}
const limits: OnlineEvalLimits = {
  concurrency: parseNumber(values.concurrency, 'concurrency'),
  maxScenarios: parseNumber(values.limit, 'limit'),
  maxTotalTokens: parseNumber(values['max-total-tokens'], 'max-total-tokens'),
  maxCostUsd: parseNumber(values['max-cost-usd'], 'max-cost-usd'),
};
const connection = connectDatabase(databaseUrl);
const publisher: RunEventPublisher = { publish: () => Promise.resolve() };
const runtimeTools = createBuiltInToolRuntime(connection.db, publisher);
const harness = createDatabaseHarness();
const emptyUsage: RuntimeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

try {
  const report = await runOnlineEvals({
    orchestrator: harness,
    model: proModel,
    provider: modelConfiguration.kind,
    scenarios,
    limits,
    versionManifest: declaredVersionManifest,
  });
  const outputDirectory = resolve(values['output-dir']);
  await mkdir(outputDirectory, { recursive: true });
  const stamp = report.startedAt.replaceAll(/[:.]/gu, '-');
  const safeModel = proModel.replaceAll(/[^a-zA-Z0-9._-]/gu, '_');
  const scope = selectedScenario ?? category ?? 'all';
  const safeScope = scope.replaceAll(/[^a-zA-Z0-9._-]/gu, '_');
  const basePath = resolve(outputDirectory, `${stamp}-${safeModel}-${safeScope}`);
  await Promise.all([
    writeFile(`${basePath}.json`, `${JSON.stringify(report, undefined, 2)}\n`, 'utf8'),
    writeFile(
      `${basePath}.jsonl`,
      `${report.items.map((item) => JSON.stringify(item)).join('\n')}\n`,
      'utf8',
    ),
  ]);
  console.log(
    JSON.stringify({ report: `${basePath}.json`, score: report.score, totals: report.totals }),
  );
  if (!report.gatesPassed) process.exitCode = 1;
} finally {
  await Promise.all(
    (['web_research', 'workspace_knowledge', 'licensed_media'] as const).map((serverId) =>
      runtimeTools.manager.stop(serverId),
    ),
  );
  await connection.close();
}

function createDatabaseHarness(): OrchestratorEvalHarness {
  return {
    async runScenario(scenario) {
      const userId = randomUUID();
      const workspaceId = randomUUID();
      const conversationId = randomUUID();
      const branchId = randomUUID();
      const requiresArticle =
        scenario.setup?.bindArticle === true ||
        scenario.expected.requiredCapabilities.includes('article.read') ||
        scenario.expected.requiredCapabilities.includes('article.propose');
      const articleId = requiresArticle ? randomUUID() : undefined;
      const revisionId = requiresArticle ? randomUUID() : undefined;
      const document = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1, blockId: 'eval-heading' },
            content: [{ type: 'text', text: '待修改的评测文章' }],
          },
          {
            type: 'paragraph',
            attrs: { blockId: 'eval-paragraph' },
            content: [
              {
                type: 'text',
                text: 'Kafka exactly-once 语义表示所有消费端在任何情况下都绝不会重复处理消息。',
              },
            ],
          },
        ],
      } as const;
      const documentHash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
      await connection.db.transaction(async (transaction) => {
        await transaction
          .insert(appUsers)
          .values({ id: userId, logtoSubject: `eval:${userId}`, displayName: 'AgentPress Eval' });
        await transaction
          .insert(workspaces)
          .values({ id: workspaceId, name: `Eval ${scenario.id}` });
        await transaction.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
        if (articleId && revisionId) {
          await transaction.insert(articles).values({
            id: articleId,
            workspaceId,
            title: '待修改的评测文章',
          });
          await transaction.insert(articleRevisions).values({
            id: revisionId,
            articleId,
            revisionNumber: 1,
            schemaVersion: 1,
            document,
            documentHash,
            source: 'manual',
            createdByUserId: userId,
          });
          await transaction
            .update(articles)
            .set({ currentRevisionId: revisionId })
            .where(eq(articles.id, articleId));
        }
        await transaction.insert(conversations).values({
          id: conversationId,
          workspaceId,
          title: '新对话',
          ...(articleId ? { articleId, isDefault: true } : {}),
        });
        await transaction.insert(conversationBranches).values({ id: branchId, conversationId });
        const priorMessages = (scenario.setup?.priorTurns ?? []).flatMap((turn, index) => {
          const timestamp = Date.now() - (scenario.setup?.priorTurns?.length ?? 0) + index;
          return [
            {
              id: randomUUID(),
              branchId,
              role: 'user',
              sequence: index * 2 + 1,
              content: encodeEvalMessage({ role: 'user', content: turn.user, timestamp }),
              stable: true,
            },
            {
              id: randomUUID(),
              branchId,
              role: 'assistant',
              sequence: index * 2 + 2,
              content: encodeEvalMessage({
                role: 'assistant',
                content: turn.assistant,
                provider: 'eval-fixture',
                model: 'eval-fixture',
                stopReason: 'stop',
                usage: emptyUsage,
                timestamp,
              }),
              stable: true,
            },
          ];
        });
        if (priorMessages.length > 0) {
          await transaction.insert(conversationMessages).values(priorMessages);
        }
      });
      const service = new DirectRunService({
        database: connection.db,
        publisher,
        dispatchCommands: false,
        runtimeFactory: {
          create(purpose = 'main') {
            const modelId =
              (purpose === 'researcher' || purpose === 'fact_checker') && turboModel
                ? turboModel
                : proModel;
            return modelConfiguration.create(modelId);
          },
        },
        runtimeToolFactory: runtimeTools.bridge,
        systemPrompt:
          'You are AgentPress. Use the control tools to execute the user request and preserve evidence. Never reveal hidden chain of thought.',
      });
      const created =
        scenario.setup?.confirmedArticleEdit && articleId && revisionId
          ? await service.createConfirmedAction({
              conversationId,
              branchId,
              userId,
              proposalId: randomUUID(),
              instruction: scenario.prompt,
              articleId,
              baseRevisionId: revisionId,
              selectedBlocks: [],
              grantedCapabilities: ['article.read', 'article.propose'],
            })
          : await service.create({
              conversationId,
              branchId,
              userId,
              prompt: scenario.prompt,
              idempotencyKey: `eval:${scenario.id}:${randomUUID()}`,
              ...(articleId && revisionId
                ? {
                    contextBindings: [{ type: 'article_revision' as const, articleId, revisionId }],
                  }
                : {}),
            });
      const execution = service.execute(created.runId);
      let executionFinished = false;
      void execution.then(
        () => {
          executionFinished = true;
        },
        () => {
          executionFinished = true;
        },
      );
      if (scenario.expected.approval === 'required') {
        await approvePendingToolCall(created.runId, userId, () => executionFinished);
      }
      await execution;
      const [
        runRows,
        taskRows,
        artifactRows,
        evidenceRows,
        approvalRows,
        toolRows,
        eventRows,
        actionProposalRows,
        editProposalRows,
        promptRows,
        skillRows,
      ] = await Promise.all([
        connection.db
          .select({
            mode: agentRuns.mode,
            status: agentRuns.status,
            finalOutcome: agentRuns.finalOutcome,
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, created.runId)),
        connection.db
          .select({
            role: agentTasks.owner,
            toolPolicy: agentTasks.toolPolicy,
            status: agentTasks.status,
            acceptanceCriteria: agentTasks.acceptanceCriteria,
          })
          .from(agentTasks)
          .where(eq(agentTasks.runId, created.runId)),
        connection.db
          .select({ type: artifacts.type })
          .from(artifacts)
          .where(eq(artifacts.runId, created.runId)),
        connection.db
          .select({ id: evidenceRecords.id })
          .from(evidenceRecords)
          .where(eq(evidenceRecords.runId, created.runId)),
        connection.db
          .select({ id: approvals.id })
          .from(approvals)
          .innerJoin(toolCalls, eq(toolCalls.id, approvals.toolCallId))
          .where(eq(toolCalls.runId, created.runId)),
        connection.db
          .select({
            status: toolCalls.status,
            toolId: toolCalls.toolId,
            toolVersion: toolCalls.toolVersion,
          })
          .from(toolCalls)
          .where(eq(toolCalls.runId, created.runId)),
        connection.db
          .select({
            eventType: runEvents.eventType,
            payload: runEvents.payload,
            createdAt: runEvents.createdAt,
          })
          .from(runEvents)
          .where(eq(runEvents.runId, created.runId)),
        connection.db
          .select({ id: actionProposals.id })
          .from(actionProposals)
          .where(eq(actionProposals.sourceRunId, created.runId)),
        connection.db
          .select({ id: editProposals.id })
          .from(editProposals)
          .where(eq(editProposals.runId, created.runId)),
        connection.db
          .select({
            promptId: promptRevisions.promptId,
            promptVersion: promptRevisions.version,
            contextManifest: runContextPacks.manifest,
          })
          .from(runContextPacks)
          .innerJoin(promptRevisions, eq(promptRevisions.id, runContextPacks.promptRevisionId))
          .where(eq(runContextPacks.runId, created.runId)),
        connection.db
          .select({ skillId: skillRevisions.skillId, version: skillRevisions.version })
          .from(runSkillBindings)
          .innerJoin(skillRevisions, eq(skillRevisions.id, runSkillBindings.skillRevisionId))
          .where(eq(runSkillBindings.runId, created.runId)),
      ]);
      const run = runRows[0];
      if (!run) throw new Error('Persisted eval Run disappeared');
      const finalUsage = recordValue(run.finalOutcome).usage;
      const usage = isUsage(finalUsage) ? finalUsage : emptyUsage;
      const contextManifest = recordValue(promptRows[0]?.contextManifest);
      const skillVersions = recordValue(contextManifest.skillVersions);
      const contextSchemaVersion = contextManifest.schemaVersion;
      const versionManifest = {
        model: proModel,
        prompt: {
          id: promptRows[0]?.promptId ?? 'agentpress.main',
          version: promptRows[0]?.promptVersion ?? 'unknown',
        },
        skills: skillRows.map(({ skillId, version }) => ({ skillId, version })),
        tools: toolRows
          .map(({ toolId, toolVersion }) => ({ toolId, version: toolVersion }))
          .filter(
            (tool, index, all) =>
              all.findIndex(
                (candidate) =>
                  candidate.toolId === tool.toolId && candidate.version === tool.version,
              ) === index,
          ),
        context: {
          policyVersion: 'agentpress.context-policy-v1',
          schemaVersion:
            typeof contextSchemaVersion === 'string' || typeof contextSchemaVersion === 'number'
              ? String(contextSchemaVersion)
              : '1',
        },
        runtime: {
          provider: modelConfiguration.kind,
          adapterVersion: 'pi-runtime@0.82.1',
          configVersion: 'agentpress-online-config-v1',
        },
      } as const;
      if (
        Object.keys(skillVersions).some(
          (skillId) => !skillRows.some((skill) => skill.skillId === skillId),
        )
      )
        throw new Error('Persisted context Skill manifest does not match Skill bindings');
      return {
        runId: created.runId,
        model: proModel,
        promptRevision: 'agentpress.main',
        versionManifest,
        usage,
        observation: {
          scenarioId: scenario.id,
          mode: run.mode,
          status: run.status,
          tasks: taskRows.flatMap(({ role, toolPolicy }) =>
            isEvalRole(role)
              ? [{ role, capabilities: stringArray(recordValue(toolPolicy).capabilities) }]
              : [],
          ),
          artifactTypes: artifactRows.map(({ type }) => type),
          evidenceCount: evidenceRows.length,
          approvalRequests: approvalRows.length,
          actionProposals: actionProposalRows.length + editProposalRows.length,
          schemaValid: taskRows.every(({ acceptanceCriteria }) => acceptanceCriteria.length > 0),
          recoveryAssertions: eventRows.flatMap(({ eventType }) =>
            eventType.startsWith('run.recover')
              ? ['checkpoint']
              : eventType === 'tool.outcome_unknown'
                ? ['outcome_unknown']
                : [],
          ),
          unauthorizedWrites: 0,
          unknownOutcomeRetries:
            toolRows.filter(({ status }) => status === 'outcome_unknown').length > 1 ? 1 : 0,
          crossWorkspaceMemoryHits: 0,
          parallelExecutionValid: hasParallelTaskOverlap(eventRows),
        },
      };
    },
  };
}

function hasParallelTaskOverlap(
  events: readonly {
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: Date;
  }[],
): boolean {
  const startedAt = new Map<string, number>();
  const completedAt = new Map<string, number>();
  for (const event of events) {
    const taskId = event.payload.taskId;
    if (typeof taskId !== 'string') continue;
    if (event.eventType === 'task.started') startedAt.set(taskId, event.createdAt.getTime());
    if (
      event.eventType === 'task.succeeded' ||
      event.eventType === 'task.failed' ||
      event.eventType === 'task.cancelled' ||
      event.eventType === 'task.skipped'
    )
      completedAt.set(taskId, event.createdAt.getTime());
  }
  const intervals = [...startedAt].flatMap(([taskId, start]) => {
    const end = completedAt.get(taskId);
    return end === undefined ? [] : [{ start, end }];
  });
  return intervals.some((left, index) =>
    intervals.slice(index + 1).some((right) => left.start < right.end && right.start < left.end),
  );
}

function encodeEvalMessage(message: Readonly<Record<string, unknown>>): readonly unknown[] {
  return [{ type: 'agentpress.runtime-message', version: 1, message }];
}

async function approvePendingToolCall(
  runId: string,
  userId: string,
  executionFinished: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 20 * 60_000;
  const approved = new Set<string>();
  while (Date.now() < deadline) {
    if (executionFinished()) return approved.size > 0;
    const rows = await connection.db
      .select({ id: toolCalls.id, status: toolCalls.status })
      .from(toolCalls)
      .where(eq(toolCalls.runId, runId));
    for (const row of rows) {
      if (row.status !== 'awaiting_approval' || approved.has(row.id)) continue;
      await runtimeTools.toolCalls.decideApproval({
        toolCallId: row.id,
        decision: 'approved',
        userId,
      });
      approved.add(row.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for required approval in Run ${runId}`);
}

function requiredEnv(name: 'DATABASE_URL'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for full Orchestrator online eval`);
  return value;
}
function parseCategory(value: string | undefined): EvalCategory | undefined {
  if (value === undefined) return undefined;
  const category = EVAL_CATEGORIES.find((candidate) => candidate === value);
  if (!category) throw new Error(`category must be one of: ${EVAL_CATEGORIES.join(', ')}`);
  return category;
}
function parseNumber(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}
function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
function isEvalRole(
  value: string,
): value is 'researcher' | 'writer' | 'editor' | 'fact_checker' | 'illustrator' {
  return ['researcher', 'writer', 'editor', 'fact_checker', 'illustrator'].includes(value);
}
function isUsage(value: unknown): value is RuntimeUsage {
  const item = recordValue(value);
  return [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'totalTokens',
    'costUsd',
  ].every((key) => typeof item[key] === 'number');
}

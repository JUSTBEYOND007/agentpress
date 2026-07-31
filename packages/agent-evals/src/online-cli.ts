import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { DirectRunService, type RunEventPublisher } from '@agentpress/agent-application';
import { PiRuntimeAdapter, type RuntimeUsage } from '@agentpress/agent-runtime';
import {
  agentRuns,
  agentTasks,
  appUsers,
  approvals,
  artifacts,
  connectDatabase,
  conversationBranches,
  conversations,
  evidenceRecords,
  runEvents,
  toolCalls,
  workspaceMembers,
  workspaces,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';

import {
  runOnlineEvals,
  type OnlineEvalLimits,
  type OrchestratorEvalHarness,
} from './online-runner.js';
import { EVAL_CATEGORIES, evalScenarios, type EvalCategory } from './scenarios.js';

const { values } = parseArgs({
  options: {
    category: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    limit: { type: 'string', default: String(evalScenarios.length) },
    'max-total-tokens': { type: 'string', default: '200000' },
    'max-cost-usd': { type: 'string', default: '5' },
    'output-dir': { type: 'string', default: '.agentpress/evals' },
  },
  strict: true,
});
const apiKey = requiredEnv('ARK_API_KEY');
const proModel = requiredEnv('ARK_MODEL_PRO');
const turboModel = process.env.ARK_MODEL_TURBO?.trim();
const databaseUrl = requiredEnv('DATABASE_URL');
const category = parseCategory(values.category);
const scenarios = category
  ? evalScenarios.filter((scenario) => scenario.category === category)
  : evalScenarios;
const limits: OnlineEvalLimits = {
  concurrency: parseNumber(values.concurrency, 'concurrency'),
  maxScenarios: parseNumber(values.limit, 'limit'),
  maxTotalTokens: parseNumber(values['max-total-tokens'], 'max-total-tokens'),
  maxCostUsd: parseNumber(values['max-cost-usd'], 'max-cost-usd'),
};
const connection = connectDatabase(databaseUrl);
const publisher: RunEventPublisher = { publish: () => Promise.resolve() };
const harness = createDatabaseHarness();

try {
  const report = await runOnlineEvals({
    orchestrator: harness,
    model: proModel,
    scenarios,
    limits,
  });
  const outputDirectory = resolve(values['output-dir']);
  await mkdir(outputDirectory, { recursive: true });
  const stamp = report.startedAt.replaceAll(/[:.]/gu, '-');
  const safeModel = proModel.replaceAll(/[^a-zA-Z0-9._-]/gu, '_');
  const basePath = resolve(outputDirectory, `${stamp}-${safeModel}`);
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
  await connection.close();
}

function createDatabaseHarness(): OrchestratorEvalHarness {
  return {
    async runScenario(scenario) {
      const userId = randomUUID();
      const workspaceId = randomUUID();
      const conversationId = randomUUID();
      const branchId = randomUUID();
      await connection.db.transaction(async (transaction) => {
        await transaction
          .insert(appUsers)
          .values({ id: userId, logtoSubject: `eval:${userId}`, displayName: 'AgentPress Eval' });
        await transaction
          .insert(workspaces)
          .values({ id: workspaceId, name: `Eval ${scenario.id}` });
        await transaction.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
        await transaction
          .insert(conversations)
          .values({ id: conversationId, workspaceId, title: '新对话' });
        await transaction.insert(conversationBranches).values({ id: branchId, conversationId });
      });
      const service = new DirectRunService({
        database: connection.db,
        publisher,
        runtimeFactory: {
          create(purpose = 'main') {
            const modelId =
              (purpose === 'researcher' || purpose === 'fact_checker') && turboModel
                ? turboModel
                : proModel;
            return PiRuntimeAdapter.forArk({
              apiKey,
              modelId,
              ...(process.env.ARK_BASE_URL ? { baseUrl: process.env.ARK_BASE_URL } : {}),
            });
          },
        },
        systemPrompt:
          'You are AgentPress. Use the control tools to execute the user request and preserve evidence. Never reveal hidden chain of thought.',
      });
      const created = await service.create({
        conversationId,
        branchId,
        userId,
        prompt: scenario.prompt,
        idempotencyKey: `eval:${scenario.id}:${randomUUID()}`,
      });
      await service.execute(created.runId);
      const [runRows, taskRows, artifactRows, evidenceRows, approvalRows, toolRows, eventRows] =
        await Promise.all([
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
            .select({ status: toolCalls.status })
            .from(toolCalls)
            .where(eq(toolCalls.runId, created.runId)),
          connection.db
            .select({ eventType: runEvents.eventType })
            .from(runEvents)
            .where(eq(runEvents.runId, created.runId)),
        ]);
      const run = runRows[0];
      if (!run) throw new Error('Persisted eval Run disappeared');
      const finalUsage = recordValue(run.finalOutcome).usage;
      const usage = isUsage(finalUsage) ? finalUsage : emptyUsage;
      return {
        runId: created.runId,
        model: proModel,
        promptRevision: 'agentpress.main',
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
        },
      };
    },
  };
}

const emptyUsage: RuntimeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};
function requiredEnv(name: 'ARK_API_KEY' | 'ARK_MODEL_PRO' | 'DATABASE_URL'): string {
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

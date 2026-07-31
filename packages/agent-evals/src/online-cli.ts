import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { PiRuntimeAdapter } from '@agentpress/agent-runtime';

import { runOnlineEvals, type OnlineEvalLimits } from './online-runner.js';
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
const model = requiredEnv('ARK_MODEL_PRO');
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

const report = await runOnlineEvals({
  runtime: PiRuntimeAdapter.forArk({ apiKey, modelId: model }),
  model,
  scenarios,
  limits,
});
const outputDirectory = resolve(values['output-dir']);
await mkdir(outputDirectory, { recursive: true });
const stamp = report.startedAt.replaceAll(/[:.]/gu, '-');
const safeModel = model.replaceAll(/[^a-zA-Z0-9._-]/gu, '_');
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

function requiredEnv(name: 'ARK_API_KEY' | 'ARK_MODEL_PRO'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; online eval never falls back to Fake Runtime`);
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

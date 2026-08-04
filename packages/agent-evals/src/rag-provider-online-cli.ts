import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ArkEmbeddingProvider, ArkRerankProvider } from '@agentpress/knowledge-retrieval';

import { runRagProviderEval } from './rag-provider-eval.js';

const defaultOutputDirectory = resolve(import.meta.dirname, '../../../.agentpress/evals');
const { values } = parseArgs({
  options: {
    'output-dir': { type: 'string', default: defaultOutputDirectory },
    limit: { type: 'string', default: '5' },
    'no-answer-threshold': { type: 'string', default: '0.5' },
  },
  strict: true,
});
const apiKey = required('ARK_API_KEY');
const configuredBaseUrl = process.env.ARK_BASE_URL?.trim();
const baseUrl = configuredBaseUrl?.length
  ? configuredBaseUrl
  : 'https://ark.cn-beijing.volces.com/api/v3';
const embeddingModel = required('ARK_EMBEDDING_MODEL');
const rerankModel = required('ARK_RERANK_MODEL');
const embedding = new ArkEmbeddingProvider({ apiKey, baseUrl, model: embeddingModel });
const reranker = new ArkRerankProvider({ apiKey, baseUrl, model: rerankModel });
const report = await runRagProviderEval({
  embed: (texts) => embedding.embed(texts),
  rerank: (query, candidates) => reranker.rerank(query, candidates),
  provider: 'volcengine-ark',
  embeddingModel,
  rerankModel,
  limit: numberOption(values.limit, 'limit'),
  noAnswerThreshold: numberOption(values['no-answer-threshold'], 'no-answer-threshold'),
});
const outputDirectory = resolve(values['output-dir']);
await mkdir(outputDirectory, { recursive: true });
const stamp = report.startedAt.replaceAll(/[:.]/gu, '-');
const path = resolve(
  outputDirectory,
  `${stamp}-${safe(embeddingModel)}-${safe(rerankModel)}-rag.json`,
);
await writeFile(path, `${JSON.stringify(report, undefined, 2)}\n`, 'utf8');
console.log(
  JSON.stringify({ report: path, metrics: report.metrics, gatesPassed: report.gatesPassed }),
);
if (!report.gatesPassed) process.exitCode = 1;

function required(name: 'ARK_API_KEY' | 'ARK_EMBEDDING_MODEL' | 'ARK_RERANK_MODEL'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for online RAG evaluation`);
  return value;
}

function numberOption(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function safe(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, '_');
}

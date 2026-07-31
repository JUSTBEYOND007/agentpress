import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { connectDatabase, conversationBranches, conversations } from '@agentpress/database';

import { DEMO_IDS, seedDemo } from './seed-demo.js';

const connectionString = requiredEnvironment('DATABASE_URL');
const apiUrl = (process.env.BENCHMARK_API_URL ?? 'http://localhost:4000/v1').replace(/\/$/, '');
const bearerToken = requiredEnvironment('BENCHMARK_BEARER_TOKEN');
const runCount = boundedInteger(process.env.RUN_COUNT, 100, 1, 100);
const sseClients = boundedInteger(process.env.SSE_CLIENTS, 1_000, 1, 1_000);
const connection = connectDatabase(connectionString);

try {
  await seedDemo(connection.db);
  const fixtures = Array.from({ length: runCount }, () => ({
    conversationId: randomUUID(),
    branchId: randomUUID(),
  }));
  await connection.db.insert(conversations).values(
    fixtures.map((fixture, index) => ({
      id: fixture.conversationId,
      workspaceId: DEMO_IDS.workspace,
      title: `Benchmark ${String(index + 1)}`,
    })),
  );
  await connection.db.insert(conversationBranches).values(
    fixtures.map((fixture) => ({
      id: fixture.branchId,
      conversationId: fixture.conversationId,
    })),
  );

  const runLatencies: number[] = [];
  const runs = await Promise.all(
    fixtures.map(async (fixture) => {
      const started = performance.now();
      const response = await fetch(`${apiUrl}/conversations/${fixture.conversationId}/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `benchmark:${randomUUID()}`,
          authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ branchId: fixture.branchId, prompt: 'Benchmark queued run' }),
      });
      runLatencies.push(performance.now() - started);
      if (!response.ok) throw new Error(`Run enqueue failed with ${String(response.status)}`);
      const value: unknown = await response.json();
      if (!isRecord(value) || typeof value.runId !== 'string') {
        throw new Error('Run enqueue response omitted runId');
      }
      return value.runId;
    }),
  );

  const controllers = Array.from({ length: sseClients }, () => new AbortController());
  const sseLatencies: number[] = [];
  try {
    await Promise.all(
      controllers.map(async (controller, index) => {
        const started = performance.now();
        const runId = runs[index % runs.length];
        if (!runId) throw new Error('No Agent Run is available for SSE benchmarking');
        const response = await fetch(`${apiUrl}/runs/${runId}/events`, {
          headers: { 'last-event-id': '0' },
          signal: controller.signal,
        });
        sseLatencies.push(performance.now() - started);
        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed with ${String(response.status)}`);
        }
      }),
    );
  } finally {
    for (const controller of controllers) controller.abort();
  }

  process.stdout.write(
    `${JSON.stringify({
      runCount,
      sseClients,
      runEnqueueMs: percentiles(runLatencies),
      sseConnectMs: percentiles(sseLatencies),
      measuredAt: new Date().toISOString(),
    })}\n`,
  );
} finally {
  await connection.close();
}

function percentiles(values: readonly number[]): Readonly<Record<string, number>> {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0);
}

function requiredEnvironment(key: string): string {
  const value: unknown = process.env[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Expected an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

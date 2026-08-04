import { describe, expect, it } from 'vitest';

import {
  buildEvalExperimentReport,
  buildEvalRegressionTrend,
  classifyEvalFailure,
  readEvalMetricDefinitions,
  type EvalArmRecord,
  type EvalExperimentRecord,
  type EvalTrialRecord,
} from '../src/index.js';

const timestamp = new Date('2026-08-04T00:00:00.000Z');

function experiment(overrides: Partial<EvalExperimentRecord> = {}): EvalExperimentRecord {
  return {
    id: 'experiment-1',
    name: 'agent-regression',
    datasetVersion: 'dataset@1',
    status: 'completed',
    config: { baselineArm: 'baseline' },
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    ...overrides,
  };
}

function arm(overrides: Partial<EvalArmRecord> = {}): EvalArmRecord {
  return {
    id: 'arm-baseline',
    experimentId: 'experiment-1',
    name: 'baseline',
    model: 'provider/baseline',
    promptVersion: 'prompt@1',
    skillVersions: { research: 'skill@1' },
    toolPolicyVersion: 'tools@1',
    contextPolicyVersion: 'context@1',
    ...overrides,
  };
}

function trial(overrides: Partial<EvalTrialRecord> = {}): EvalTrialRecord {
  return {
    id: 'trial-1',
    armId: 'arm-baseline',
    caseId: 'case-1',
    attempt: 1,
    status: 'succeeded',
    resultMetrics: {
      succeeded: true,
      schemaValid: true,
      citationPrecision: 1,
      artifactQuality: 0.8,
      minimalEdit: true,
      unknownAnswerCorrect: true,
    },
    processMetrics: { toolCallCount: 2, costUsd: 0.5, latencyMs: 1_000 },
    failure: null,
    ...overrides,
  };
}

describe('evaluation experiment reporting', () => {
  it('aggregates only decided trials and exposes trace and structured failure facts', () => {
    const report = buildEvalExperimentReport({
      experiment: experiment(),
      arms: [arm()],
      trials: [
        trial(),
        trial({
          id: 'trial-2',
          caseId: 'case-2',
          status: 'failed',
          resultMetrics: { succeeded: false, schemaValid: false, citationPrecision: 0 },
          processMetrics: { toolCallCount: 4, costUsd: 1.5, latencyMs: 3_000 },
          failure: { code: 'schema_invalid' },
        }),
        trial({
          id: 'trial-running',
          caseId: 'case-3',
          status: 'running',
          processMetrics: { costUsd: 100, latencyMs: 100_000 },
        }),
        trial({ id: 'trial-cancelled', caseId: 'case-4', status: 'cancelled' }),
      ],
      traces: [{ trialId: 'trial-1', traceHash: 'sha256:a' }],
    });

    expect(report.arms[0]).toMatchObject({
      totalTrials: 4,
      decidedTrials: 2,
      passedTrials: 1,
      failedTrials: 1,
      cancelledTrials: 1,
      successRate: 0.5,
      traceCount: 1,
    });
    expect(report.arms[0]?.resultMetrics).toMatchObject({
      succeeded: 0.5,
      schemaValid: 0.5,
      citationPrecision: 0.5,
    });
    expect(report.arms[0]?.processMetrics).toMatchObject({
      toolCallCount: 3,
      costUsd: 2,
      latencyMs: 2_000,
    });
    expect(report.arms[0]?.failureCounts).toMatchObject({ schema: 1, cancelled: 1 });
    expect(report.arms[0]?.trials[0]).toMatchObject({
      traceAvailable: true,
      traceHash: 'sha256:a',
    });
  });

  it('compares versioned arms with metric direction and explicit config differences', () => {
    const baseline = arm();
    const candidate = arm({
      id: 'arm-candidate',
      name: 'candidate',
      model: 'provider/candidate',
      promptVersion: 'prompt@2',
    });
    const report = buildEvalExperimentReport({
      experiment: experiment(),
      arms: [baseline, candidate],
      trials: [
        trial(),
        trial({
          id: 'candidate-trial',
          armId: candidate.id,
          processMetrics: { toolCallCount: 1, costUsd: 0.25, latencyMs: 800 },
        }),
      ],
      traces: [],
    });

    expect(report.comparisons).toHaveLength(1);
    expect(report.comparisons[0]?.configDifferences).toEqual(['model', 'promptVersion']);
    expect(report.comparisons[0]?.metricDeltas.find(({ key }) => key === 'costUsd')).toEqual({
      key: 'costUsd',
      baseline: 0.5,
      candidate: 0.25,
      delta: -0.25,
      outcome: 'improved',
    });
    expect(
      report.comparisons[0]?.metricDeltas.find(({ key }) => key === 'succeeded'),
    ).toMatchObject({
      delta: 0,
      outcome: 'unchanged',
    });
  });

  it('uses complete benchmark-owned metric definitions or falls back atomically', () => {
    const custom = {
      metricDefinitions: [
        {
          key: 'faithfulness',
          label: 'Faithfulness',
          layer: 'result',
          format: 'percent',
          higherIsBetter: true,
          aggregation: 'mean',
        },
      ],
    };
    expect(readEvalMetricDefinitions(custom)).toEqual(custom.metricDefinitions);
    expect(
      readEvalMetricDefinitions({
        metricDefinitions: [...custom.metricDefinitions, { key: 'broken' }],
      }),
    ).not.toContainEqual({ key: 'broken' });
  });

  it('builds chronological regression points without treating missing arms as zero', () => {
    const first = buildEvalExperimentReport({
      experiment: experiment({ id: 'first', datasetVersion: 'dataset@1' }),
      arms: [arm()],
      trials: [trial()],
      traces: [],
    });
    const missing = buildEvalExperimentReport({
      experiment: experiment({
        id: 'missing',
        datasetVersion: 'dataset@2',
        createdAt: new Date('2026-08-05T00:00:00.000Z'),
      }),
      arms: [arm({ id: 'other', name: 'other' })],
      trials: [],
      traces: [],
    });
    const last = buildEvalExperimentReport({
      experiment: experiment({
        id: 'last',
        datasetVersion: 'dataset@3',
        createdAt: new Date('2026-08-06T00:00:00.000Z'),
      }),
      arms: [arm()],
      trials: [trial({ status: 'failed', resultMetrics: { succeeded: false } })],
      traces: [],
    });

    expect(
      buildEvalRegressionTrend([last, first, missing], { arm: 'baseline', metricKey: 'succeeded' }),
    ).toEqual([
      expect.objectContaining({ experimentId: 'first', value: 1, deltaFromPrevious: null }),
      expect.objectContaining({ experimentId: 'missing', value: null, deltaFromPrevious: null }),
      expect.objectContaining({ experimentId: 'last', value: 0, deltaFromPrevious: -1 }),
    ]);
  });

  it('classifies only structured failure facts and keeps unknown codes explicit', () => {
    expect(classifyEvalFailure({ category: 'authorization' }, 'failed')).toBe('authorization');
    expect(classifyEvalFailure({ code: 'tool_error' }, 'failed')).toBe('tool');
    expect(classifyEvalFailure({ code: 'new-provider-failure' }, 'failed')).toBe('unknown');
    expect(classifyEvalFailure(null, 'succeeded')).toBeUndefined();
  });
});

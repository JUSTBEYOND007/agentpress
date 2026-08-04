export type EvalMetricLayer = 'result' | 'process';
export type EvalMetricFormat = 'percent' | 'number' | 'usd' | 'milliseconds' | 'tokens';
export type EvalMetricAggregation = 'mean' | 'sum';

export type EvalMetricDefinition = {
  readonly key: string;
  readonly label: string;
  readonly layer: EvalMetricLayer;
  readonly format: EvalMetricFormat;
  readonly higherIsBetter: boolean;
  readonly aggregation: EvalMetricAggregation;
};

export const DEFAULT_EVAL_METRICS: readonly EvalMetricDefinition[] = [
  metric('succeeded', 'Task success', 'result', 'percent', true, 'mean'),
  metric('schemaValid', 'Schema validity', 'result', 'percent', true, 'mean'),
  metric('citationPrecision', 'Citation precision', 'result', 'percent', true, 'mean'),
  metric('artifactQuality', 'Article quality', 'result', 'number', true, 'mean'),
  metric('minimalEdit', 'Minimal edit', 'result', 'percent', true, 'mean'),
  metric('unknownAnswerCorrect', 'No-answer accuracy', 'result', 'percent', true, 'mean'),
  metric('routeCount', 'Routes per trial', 'process', 'number', false, 'mean'),
  metric('delegationCount', 'Delegations per trial', 'process', 'number', false, 'mean'),
  metric('toolCallCount', 'Tool calls per trial', 'process', 'number', false, 'mean'),
  metric('approvalCount', 'Approvals per trial', 'process', 'number', false, 'mean'),
  metric('retryCount', 'Retries per trial', 'process', 'number', false, 'mean'),
  metric('recoveryCount', 'Recoveries per trial', 'process', 'number', false, 'mean'),
  metric('repeatedSideEffectCount', 'Repeated side effects', 'process', 'number', false, 'sum'),
  metric('inputTokens', 'Input tokens', 'process', 'tokens', false, 'sum'),
  metric('outputTokens', 'Output tokens', 'process', 'tokens', false, 'sum'),
  metric('costUsd', 'Cost', 'process', 'usd', false, 'sum'),
  metric('latencyMs', 'Mean latency', 'process', 'milliseconds', false, 'mean'),
];

export type EvalExperimentRecord = {
  readonly id: string;
  readonly name: string;
  readonly datasetVersion: string;
  readonly status: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
};

export type EvalArmRecord = {
  readonly id: string;
  readonly experimentId: string;
  readonly name: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly skillVersions: Readonly<Record<string, string>>;
  readonly toolPolicyVersion: string;
  readonly contextPolicyVersion: string;
};

export type EvalTrialRecord = {
  readonly id: string;
  readonly armId: string;
  readonly caseId: string;
  readonly attempt: number;
  readonly status: string;
  readonly resultMetrics: Readonly<Record<string, unknown>>;
  readonly processMetrics: Readonly<Record<string, unknown>>;
  readonly failure: Readonly<Record<string, unknown>> | null;
};

export type EvalTraceRecord = {
  readonly trialId: string;
  readonly traceHash: string;
};

export type EvalFailureCategory =
  | 'schema'
  | 'citation'
  | 'authorization'
  | 'tool'
  | 'runtime'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export type EvalTrialProjection = {
  readonly id: string;
  readonly caseId: string;
  readonly attempt: number;
  readonly status: string;
  readonly resultMetrics: Readonly<Record<string, number>>;
  readonly processMetrics: Readonly<Record<string, number>>;
  readonly failureCategory?: EvalFailureCategory;
  readonly traceAvailable: boolean;
  readonly traceHash?: string;
};

export type EvalArmSummary = {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly skillVersions: Readonly<Record<string, string>>;
  readonly toolPolicyVersion: string;
  readonly contextPolicyVersion: string;
  readonly totalTrials: number;
  readonly decidedTrials: number;
  readonly passedTrials: number;
  readonly failedTrials: number;
  readonly cancelledTrials: number;
  readonly successRate: number | null;
  readonly traceCount: number;
  readonly failureCounts: Readonly<Record<EvalFailureCategory, number>>;
  readonly resultMetrics: Readonly<Record<string, number | null>>;
  readonly processMetrics: Readonly<Record<string, number | null>>;
  readonly trials: readonly EvalTrialProjection[];
};

export type EvalMetricDelta = {
  readonly key: string;
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
  readonly outcome: 'improved' | 'regressed' | 'unchanged' | 'unavailable';
};

export type EvalArmComparison = {
  readonly baselineArm: string;
  readonly candidateArm: string;
  readonly configDifferences: readonly string[];
  readonly metricDeltas: readonly EvalMetricDelta[];
};

export type EvalExperimentReport = {
  readonly id: string;
  readonly name: string;
  readonly datasetVersion: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly tracePolicy: 'diagnostic_only';
  readonly metricDefinitions: readonly EvalMetricDefinition[];
  readonly arms: readonly EvalArmSummary[];
  readonly comparisons: readonly EvalArmComparison[];
};

export type EvalRegressionPoint = {
  readonly experimentId: string;
  readonly datasetVersion: string;
  readonly createdAt: Date;
  readonly arm: string;
  readonly metricKey: string;
  readonly value: number | null;
  readonly deltaFromPrevious: number | null;
};

const FAILURE_CATEGORIES = new Set<EvalFailureCategory>([
  'schema',
  'citation',
  'authorization',
  'tool',
  'runtime',
  'timeout',
  'cancelled',
  'unknown',
]);

const FAILURE_CODES: Readonly<Record<string, EvalFailureCategory>> = {
  schema_invalid: 'schema',
  citation_invalid: 'citation',
  unauthorized: 'authorization',
  permission_denied: 'authorization',
  tool_error: 'tool',
  runtime_error: 'runtime',
  timeout: 'timeout',
  cancelled: 'cancelled',
};

export function readEvalMetricDefinitions(
  config: Readonly<Record<string, unknown>>,
): readonly EvalMetricDefinition[] {
  const configured = config.metricDefinitions;
  if (!Array.isArray(configured) || configured.length === 0) return DEFAULT_EVAL_METRICS;
  const parsed = configured.map(parseMetricDefinition);
  return parsed.every((definition): definition is EvalMetricDefinition => definition !== undefined)
    ? parsed
    : DEFAULT_EVAL_METRICS;
}

export function buildEvalExperimentReport(input: {
  readonly experiment: EvalExperimentRecord;
  readonly arms: readonly EvalArmRecord[];
  readonly trials: readonly EvalTrialRecord[];
  readonly traces: readonly EvalTraceRecord[];
}): EvalExperimentReport {
  const definitions = readEvalMetricDefinitions(input.experiment.config);
  const traces = new Map(input.traces.map((trace) => [trace.trialId, trace]));
  const summaries = input.arms.map((arm) =>
    summarizeEvalArm(
      arm,
      input.trials.filter((trial) => trial.armId === arm.id),
      traces,
      definitions,
    ),
  );
  const baselineName =
    typeof input.experiment.config.baselineArm === 'string'
      ? input.experiment.config.baselineArm
      : summaries[0]?.name;
  const baseline = summaries.find(({ name }) => name === baselineName) ?? summaries[0];
  return {
    id: input.experiment.id,
    name: input.experiment.name,
    datasetVersion: input.experiment.datasetVersion,
    status: input.experiment.status,
    createdAt: input.experiment.createdAt,
    updatedAt: input.experiment.updatedAt,
    completedAt: input.experiment.completedAt,
    tracePolicy: 'diagnostic_only',
    metricDefinitions: definitions,
    arms: summaries,
    comparisons: baseline
      ? summaries
          .filter(({ id }) => id !== baseline.id)
          .map((candidate) => compareEvalArms(baseline, candidate, definitions))
      : [],
  };
}

export function buildEvalRegressionTrend(
  reports: readonly EvalExperimentReport[],
  input: { readonly arm: string; readonly metricKey: string },
): readonly EvalRegressionPoint[] {
  let previous: number | null = null;
  return [...reports]
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .map((report) => {
      const arm = report.arms.find(({ name }) => name === input.arm);
      const value = arm ? metricValue(arm, input.metricKey) : null;
      const point: EvalRegressionPoint = {
        experimentId: report.id,
        datasetVersion: report.datasetVersion,
        createdAt: report.createdAt,
        arm: input.arm,
        metricKey: input.metricKey,
        value,
        deltaFromPrevious: value === null || previous === null ? null : value - previous,
      };
      if (value !== null) previous = value;
      return point;
    });
}

function summarizeEvalArm(
  arm: EvalArmRecord,
  trials: readonly EvalTrialRecord[],
  traces: ReadonlyMap<string, EvalTraceRecord>,
  definitions: readonly EvalMetricDefinition[],
): EvalArmSummary {
  const projected = trials.map((trial) => projectTrial(trial, traces.get(trial.id)));
  const decided = projected.filter(({ status }) => status === 'succeeded' || status === 'failed');
  const passed = decided.filter(({ status }) => status === 'succeeded').length;
  const failureCounts = emptyFailureCounts();
  for (const trial of projected) {
    if (trial.failureCategory) failureCounts[trial.failureCategory] += 1;
  }
  const resultMetrics = aggregateLayer(decided, definitions, 'result');
  return {
    id: arm.id,
    name: arm.name,
    model: arm.model,
    promptVersion: arm.promptVersion,
    skillVersions: arm.skillVersions,
    toolPolicyVersion: arm.toolPolicyVersion,
    contextPolicyVersion: arm.contextPolicyVersion,
    totalTrials: projected.length,
    decidedTrials: decided.length,
    passedTrials: passed,
    failedTrials: decided.length - passed,
    cancelledTrials: projected.filter(({ status }) => status === 'cancelled').length,
    successRate: decided.length === 0 ? null : passed / decided.length,
    traceCount: projected.filter(({ traceAvailable }) => traceAvailable).length,
    failureCounts,
    resultMetrics: {
      ...resultMetrics,
      ...(definitions.some(({ key, layer }) => key === 'succeeded' && layer === 'result')
        ? { succeeded: decided.length === 0 ? null : passed / decided.length }
        : {}),
    },
    processMetrics: aggregateLayer(decided, definitions, 'process'),
    trials: projected,
  };
}

function projectTrial(trial: EvalTrialRecord, trace?: EvalTraceRecord): EvalTrialProjection {
  const failureCategory = classifyEvalFailure(trial.failure, trial.status);
  return {
    id: trial.id,
    caseId: trial.caseId,
    attempt: trial.attempt,
    status: trial.status,
    resultMetrics: numericMetrics(trial.resultMetrics),
    processMetrics: numericMetrics(trial.processMetrics),
    ...(failureCategory ? { failureCategory } : {}),
    traceAvailable: trace !== undefined,
    ...(trace ? { traceHash: trace.traceHash } : {}),
  };
}

export function classifyEvalFailure(
  failure: Readonly<Record<string, unknown>> | null,
  status: string,
): EvalFailureCategory | undefined {
  if (status === 'cancelled') return 'cancelled';
  if (!failure) return status === 'failed' ? 'unknown' : undefined;
  const category = failure.category;
  if (typeof category === 'string' && FAILURE_CATEGORIES.has(category as EvalFailureCategory)) {
    return category as EvalFailureCategory;
  }
  const code = failure.code;
  return typeof code === 'string' ? (FAILURE_CODES[code] ?? 'unknown') : 'unknown';
}

function compareEvalArms(
  baseline: EvalArmSummary,
  candidate: EvalArmSummary,
  definitions: readonly EvalMetricDefinition[],
): EvalArmComparison {
  return {
    baselineArm: baseline.name,
    candidateArm: candidate.name,
    configDifferences: configDifferences(baseline, candidate),
    metricDeltas: definitions.map((definition) => {
      const baseValue = metricValue(baseline, definition.key);
      const candidateValue = metricValue(candidate, definition.key);
      const delta =
        baseValue === null || candidateValue === null ? null : candidateValue - baseValue;
      const direction = delta === null ? null : delta * (definition.higherIsBetter ? 1 : -1);
      return {
        key: definition.key,
        baseline: baseValue,
        candidate: candidateValue,
        delta,
        outcome:
          direction === null
            ? 'unavailable'
            : direction > 0
              ? 'improved'
              : direction < 0
                ? 'regressed'
                : 'unchanged',
      };
    }),
  };
}

function configDifferences(baseline: EvalArmSummary, candidate: EvalArmSummary): readonly string[] {
  const fields: (readonly [string, unknown, unknown])[] = [
    ['model', baseline.model, candidate.model],
    ['promptVersion', baseline.promptVersion, candidate.promptVersion],
    ['skillVersions', baseline.skillVersions, candidate.skillVersions],
    ['toolPolicyVersion', baseline.toolPolicyVersion, candidate.toolPolicyVersion],
    ['contextPolicyVersion', baseline.contextPolicyVersion, candidate.contextPolicyVersion],
  ];
  return fields
    .filter(([, left, right]) => stableValue(left) !== stableValue(right))
    .map(([field]) => field);
}

function aggregateLayer(
  trials: readonly EvalTrialProjection[],
  definitions: readonly EvalMetricDefinition[],
  layer: EvalMetricLayer,
): Readonly<Record<string, number | null>> {
  return Object.fromEntries(
    definitions
      .filter((definition) => definition.layer === layer)
      .map((definition) => {
        const values = trials
          .map((trial) =>
            layer === 'result'
              ? trial.resultMetrics[definition.key]
              : trial.processMetrics[definition.key],
          )
          .filter((value): value is number => value !== undefined);
        const total = values.reduce((sum, value) => sum + value, 0);
        return [
          definition.key,
          values.length === 0
            ? null
            : definition.aggregation === 'sum'
              ? total
              : total / values.length,
        ];
      }),
  );
}

function metricValue(arm: EvalArmSummary, key: string): number | null {
  if (key === 'succeeded') return arm.successRate;
  return arm.resultMetrics[key] ?? arm.processMetrics[key] ?? null;
}

function numericMetrics(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (typeof item === 'boolean') return [[key, item ? 1 : 0]];
      return typeof item === 'number' && Number.isFinite(item) ? [[key, item]] : [];
    }),
  );
}

function emptyFailureCounts(): Record<EvalFailureCategory, number> {
  return {
    schema: 0,
    citation: 0,
    authorization: 0,
    tool: 0,
    runtime: 0,
    timeout: 0,
    cancelled: 0,
    unknown: 0,
  };
}

function metric(
  key: string,
  label: string,
  layer: EvalMetricLayer,
  format: EvalMetricFormat,
  higherIsBetter: boolean,
  aggregation: EvalMetricAggregation,
): EvalMetricDefinition {
  return { key, label, layer, format, higherIsBetter, aggregation };
}

function parseMetricDefinition(value: unknown): EvalMetricDefinition | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Readonly<Record<string, unknown>>;
  if (
    typeof item.key !== 'string' ||
    !item.key.trim() ||
    typeof item.label !== 'string' ||
    !item.label.trim() ||
    (item.layer !== 'result' && item.layer !== 'process') ||
    !['percent', 'number', 'usd', 'milliseconds', 'tokens'].includes(String(item.format)) ||
    typeof item.higherIsBetter !== 'boolean' ||
    (item.aggregation !== 'mean' && item.aggregation !== 'sum')
  ) {
    return undefined;
  }
  return item as EvalMetricDefinition;
}

function stableValue(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  );
}

'use client';

import { Activity, FileSearch, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { authenticatedFetch } from '../lib/authenticated-fetch';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

type ExperimentItem = {
  readonly id: string;
  readonly name: string;
  readonly datasetVersion: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type MetricDefinition = {
  readonly key: string;
  readonly label: string;
  readonly layer: 'result' | 'process';
  readonly format: 'percent' | 'number' | 'usd' | 'milliseconds' | 'tokens';
};

type Trial = {
  readonly id: string;
  readonly caseId: string;
  readonly attempt: number;
  readonly status: string;
  readonly failureCategory?: string;
  readonly traceAvailable: boolean;
};

type Arm = {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly skillVersions: Readonly<Record<string, string>>;
  readonly totalTrials: number;
  readonly decidedTrials: number;
  readonly passedTrials: number;
  readonly failedTrials: number;
  readonly successRate: number | null;
  readonly traceCount: number;
  readonly failureCounts: Readonly<Record<string, number>>;
  readonly resultMetrics: Readonly<Record<string, number | null>>;
  readonly processMetrics: Readonly<Record<string, number | null>>;
  readonly trials: readonly Trial[];
};

type Comparison = {
  readonly baselineArm: string;
  readonly candidateArm: string;
  readonly configDifferences: readonly string[];
  readonly metricDeltas: readonly {
    readonly key: string;
    readonly delta: number | null;
    readonly outcome: string;
  }[];
};

type ExperimentReport = ExperimentItem & {
  readonly completedAt: string | null;
  readonly metricDefinitions: readonly MetricDefinition[];
  readonly arms: readonly Arm[];
  readonly comparisons: readonly Comparison[];
};

type RegressionPoint = {
  readonly experimentId: string;
  readonly datasetVersion: string;
  readonly createdAt: string;
  readonly value: number | null;
  readonly deltaFromPrevious: number | null;
};

type TrialTrace = {
  readonly traceHash: string;
  readonly events: readonly unknown[];
};

export function EvalDashboard({
  workspaceId,
}: {
  readonly workspaceId: string;
}): React.JSX.Element {
  const [experiments, setExperiments] = useState<readonly ExperimentItem[]>([]);
  const [experimentId, setExperimentId] = useState('');
  const [report, setReport] = useState<ExperimentReport>();
  const [tab, setTab] = useState<'overview' | 'trials'>('overview');
  const [armId, setArmId] = useState('');
  const [trendMetric, setTrendMetric] = useState('succeeded');
  const [trend, setTrend] = useState<readonly RegressionPoint[]>([]);
  const [trace, setTrace] = useState<TrialTrace>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const loadExperiments = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await authenticatedFetch(
        `${apiUrl}/workspaces/${workspaceId}/evals/experiments`,
      );
      if (!response.ok) throw new Error(`评估列表加载失败 (${String(response.status)})`);
      const items = (await response.json()) as ExperimentItem[];
      setExperiments(items);
      setExperimentId((current) =>
        current && items.some(({ id }) => id === current) ? current : (items[0]?.id ?? ''),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '评估列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadExperiments();
  }, [loadExperiments]);

  useEffect(() => {
    if (!experimentId) {
      setReport(undefined);
      return;
    }
    void authenticatedFetch(
      `${apiUrl}/workspaces/${workspaceId}/evals/experiments/${experimentId}/report`,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`评估报告加载失败 (${String(response.status)})`);
        return (await response.json()) as ExperimentReport;
      })
      .then((nextReport) => {
        setReport(nextReport);
        setArmId(nextReport.arms[0]?.id ?? '');
        setError(undefined);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '评估报告加载失败');
      });
  }, [experimentId, workspaceId]);

  const activeArm = report?.arms.find(({ id }) => id === armId) ?? report?.arms[0];
  const trendDefinition = report?.metricDefinitions.find(({ key }) => key === trendMetric);

  useEffect(() => {
    if (!report || !activeArm || !trendDefinition) {
      setTrend([]);
      return;
    }
    const query = new URLSearchParams({
      experimentName: report.name,
      arm: activeArm.name,
      metricKey: trendDefinition.key,
    });
    void authenticatedFetch(
      `${apiUrl}/workspaces/${workspaceId}/evals/regression-trend?${query.toString()}`,
    )
      .then(async (response) => (response.ok ? ((await response.json()) as RegressionPoint[]) : []))
      .then(setTrend)
      .catch(() => {
        setTrend([]);
      });
  }, [activeArm, report, trendDefinition, workspaceId]);

  const loadTrace = useCallback(
    async (trialId: string): Promise<void> => {
      const response = await authenticatedFetch(
        `${apiUrl}/workspaces/${workspaceId}/evals/trials/${trialId}/trace`,
      );
      if (!response.ok) throw new Error(`Trace 加载失败 (${String(response.status)})`);
      setTrace((await response.json()) as TrialTrace);
    },
    [workspaceId],
  );

  const metricGroups = useMemo(
    () => ({
      result: report?.metricDefinitions.filter(({ layer }) => layer === 'result') ?? [],
      process: report?.metricDefinitions.filter(({ layer }) => layer === 'process') ?? [],
    }),
    [report],
  );

  return (
    <section className="eval-dashboard">
      <header className="eval-heading">
        <div>
          <p>Agent Eval</p>
          <h1>评估报告</h1>
        </div>
        <div className="eval-heading-controls">
          <select
            aria-label="选择评估实验"
            onChange={(event) => {
              setExperimentId(event.target.value);
            }}
            value={experimentId}
          >
            {experiments.map((experiment) => (
              <option key={experiment.id} value={experiment.id}>
                {experiment.name} · {experiment.datasetVersion}
              </option>
            ))}
          </select>
          <button
            aria-label="刷新评估报告"
            onClick={() => void loadExperiments()}
            title="刷新"
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} />
          </button>
        </div>
      </header>

      {loading ? <p className="eval-empty">正在加载评估实验...</p> : null}
      {!loading && experiments.length === 0 ? <p className="eval-empty">暂无评估实验</p> : null}
      {error ? (
        <p className="eval-error" role="alert">
          {error}
        </p>
      ) : null}
      {report ? (
        <>
          <div className="eval-summary-band">
            <Summary label="状态" value={statusLabel(report.status)} />
            <Summary label="数据集" value={report.datasetVersion} />
            <Summary label="模型组" value={String(report.arms.length)} />
            <Summary label="更新时间" value={formatDate(report.updatedAt)} />
          </div>

          <div className="eval-tabs" role="tablist" aria-label="评估报告视图">
            <button
              aria-selected={tab === 'overview'}
              onClick={() => {
                setTab('overview');
              }}
              role="tab"
              type="button"
            >
              概览
            </button>
            <button
              aria-selected={tab === 'trials'}
              onClick={() => {
                setTab('trials');
              }}
              role="tab"
              type="button"
            >
              试次与 Trace
            </button>
          </div>

          {tab === 'overview' ? (
            <div className="eval-overview">
              <MetricTable
                arms={report.arms}
                definitions={metricGroups.result}
                layer="result"
                title="结果指标"
              />
              <MetricTable
                arms={report.arms}
                definitions={metricGroups.process}
                layer="process"
                title="过程指标"
              />
              <FailureBreakdown arms={report.arms} />
              <ComparisonTable
                comparisons={report.comparisons}
                definitions={report.metricDefinitions}
              />
              <section className="eval-section">
                <div className="eval-section-title">
                  <div>
                    <Activity aria-hidden="true" size={16} />
                    <h2>回归趋势</h2>
                  </div>
                  <select
                    aria-label="趋势指标"
                    onChange={(event) => {
                      setTrendMetric(event.target.value);
                    }}
                    value={trendMetric}
                  >
                    {report.metricDefinitions.map((definition) => (
                      <option key={definition.key} value={definition.key}>
                        {definition.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="eval-trend" aria-label="回归趋势数据">
                  {trend.map((point) => (
                    <div key={point.experimentId}>
                      <span>{point.datasetVersion}</span>
                      <strong>
                        {formatMetric(point.value, trendDefinition?.format ?? 'number')}
                      </strong>
                      <small>
                        {formatDelta(point.deltaFromPrevious, trendDefinition?.format ?? 'number')}
                      </small>
                    </div>
                  ))}
                  {trend.length === 0 ? <p>暂无趋势数据</p> : null}
                </div>
              </section>
            </div>
          ) : (
            <section className="eval-section eval-trials-section">
              <div className="eval-section-title">
                <h2>试次</h2>
                <select
                  aria-label="选择模型组"
                  onChange={(event) => {
                    setArmId(event.target.value);
                  }}
                  value={activeArm?.id ?? ''}
                >
                  {report.arms.map((arm) => (
                    <option key={arm.id} value={arm.id}>
                      {arm.name} · {arm.model}
                    </option>
                  ))}
                </select>
              </div>
              <table className="eval-table">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Attempt</th>
                    <th>状态</th>
                    <th>失败分类</th>
                    <th>Trace</th>
                  </tr>
                </thead>
                <tbody>
                  {activeArm?.trials.map((trial) => (
                    <tr key={trial.id}>
                      <td>{trial.caseId}</td>
                      <td>{trial.attempt}</td>
                      <td>
                        <Status value={trial.status} />
                      </td>
                      <td>{trial.failureCategory ?? '-'}</td>
                      <td>
                        {trial.traceAvailable ? (
                          <button
                            className="eval-trace-button"
                            aria-label={`查看 ${trial.caseId} Trace`}
                            onClick={() =>
                              void loadTrace(trial.id).catch((reason: unknown) => {
                                setError(
                                  reason instanceof Error ? reason.message : 'Trace 加载失败',
                                );
                              })
                            }
                            title="查看 Trace"
                            type="button"
                          >
                            <FileSearch aria-hidden="true" size={16} />
                          </button>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      ) : null}

      {trace ? (
        <aside className="eval-trace-drawer" aria-label="Trial Trace">
          <header>
            <div>
              <span>Trace</span>
              <code>{trace.traceHash.slice(0, 12)}</code>
            </div>
            <button
              aria-label="关闭 Trace"
              onClick={() => {
                setTrace(undefined);
              }}
              type="button"
            >
              <X size={17} />
            </button>
          </header>
          <pre>{JSON.stringify(trace.events, null, 2)}</pre>
        </aside>
      ) : null}
    </section>
  );
}

function Summary({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Status({ value }: { readonly value: string }) {
  return (
    <span className={`eval-status eval-status-${statusTone(value)}`}>{statusLabel(value)}</span>
  );
}

function MetricTable({
  arms,
  definitions,
  layer,
  title,
}: {
  readonly arms: readonly Arm[];
  readonly definitions: readonly MetricDefinition[];
  readonly layer: 'result' | 'process';
  readonly title: string;
}) {
  return (
    <section className="eval-section">
      <div className="eval-section-title">
        <h2>{title}</h2>
      </div>
      <table className="eval-table">
        <thead>
          <tr>
            <th>指标</th>
            {arms.map((arm) => (
              <th key={arm.id}>{arm.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {definitions.map((definition) => (
            <tr key={definition.key}>
              <td>{definition.label}</td>
              {arms.map((arm) => (
                <td key={arm.id}>
                  {formatMetric(
                    (layer === 'result' ? arm.resultMetrics : arm.processMetrics)[definition.key] ??
                      null,
                    definition.format,
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function FailureBreakdown({ arms }: { readonly arms: readonly Arm[] }) {
  const categories = [
    'schema',
    'citation',
    'authorization',
    'tool',
    'runtime',
    'timeout',
    'cancelled',
    'unknown',
  ];
  return (
    <section className="eval-section">
      <div className="eval-section-title">
        <h2>失败分类</h2>
      </div>
      <table className="eval-table">
        <thead>
          <tr>
            <th>分类</th>
            {arms.map((arm) => (
              <th key={arm.id}>{arm.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <tr key={category}>
              <td>{category}</td>
              {arms.map((arm) => (
                <td key={arm.id}>{arm.failureCounts[category] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ComparisonTable({
  comparisons,
  definitions,
}: {
  readonly comparisons: readonly Comparison[];
  readonly definitions: readonly MetricDefinition[];
}) {
  if (comparisons.length === 0) return null;
  return (
    <section className="eval-section">
      <div className="eval-section-title">
        <h2>模型差异</h2>
      </div>
      {comparisons.map((comparison) => (
        <div
          className="eval-comparison"
          key={`${comparison.baselineArm}:${comparison.candidateArm}`}
        >
          <header>
            <strong>{comparison.candidateArm}</strong>
            <span>vs {comparison.baselineArm}</span>
            <small>{comparison.configDifferences.join(' · ') || '配置一致'}</small>
          </header>
          <div>
            {comparison.metricDeltas.map((metric) => {
              const definition = definitions.find(({ key }) => key === metric.key);
              return (
                <span className={`eval-delta eval-delta-${metric.outcome}`} key={metric.key}>
                  {definition?.label ?? metric.key}{' '}
                  <strong>{formatDelta(metric.delta, definition?.format ?? 'number')}</strong>
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

export function formatMetric(value: number | null, format: MetricDefinition['format']): string {
  if (value === null) return '-';
  if (format === 'percent') return `${(value * 100).toFixed(1)}%`;
  if (format === 'usd') return `$${value.toFixed(4)}`;
  if (format === 'milliseconds') return `${Math.round(value).toLocaleString()} ms`;
  if (format === 'tokens') return Math.round(value).toLocaleString();
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatDelta(value: number | null, format: MetricDefinition['format']): string {
  if (value === null) return '-';
  const formatted = formatMetric(Math.abs(value), format);
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${formatted}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function statusLabel(value: string): string {
  return (
    (
      {
        draft: '草稿',
        running: '运行中',
        completed: '已完成',
        succeeded: '通过',
        failed: '失败',
        cancelled: '已取消',
        pending: '等待中',
      } as Record<string, string>
    )[value] ?? value
  );
}

function statusTone(value: string): string {
  if (value === 'completed' || value === 'succeeded') return 'success';
  if (value === 'failed' || value === 'cancelled') return 'danger';
  return 'neutral';
}

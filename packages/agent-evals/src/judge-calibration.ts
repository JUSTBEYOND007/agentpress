import type { JudgePairReport } from './judge.js';

export type JudgeGoldLabel = {
  readonly caseId: string;
  readonly winner: 'candidateA' | 'candidateB' | 'tie';
  readonly scoreA: number;
  readonly scoreB: number;
};

export type JudgeCalibrationReport = {
  readonly total: number;
  readonly winnerCorrect: number;
  readonly winnerAccuracy: number;
  readonly scoreMeanAbsoluteError: number;
  readonly disagreements: readonly string[];
};

export function calibrateJudge(
  reports: readonly JudgePairReport[],
  gold: readonly JudgeGoldLabel[],
): JudgeCalibrationReport {
  const byCase = new Map(gold.map((item) => [item.caseId, item]));
  let winnerCorrect = 0;
  let scoreError = 0;
  let scored = 0;
  const disagreements: string[] = [];
  for (const report of reports) {
    const expected = byCase.get(report.caseId);
    if (!expected) continue;
    const winner = resolveWinner(report);
    if (winner === expected.winner) winnerCorrect += 1;
    else disagreements.push(report.caseId);
    scoreError +=
      Math.abs(report.scoreA - expected.scoreA) + Math.abs(report.scoreB - expected.scoreB);
    scored += 2;
  }
  const total = reports.filter((report) => byCase.has(report.caseId)).length;
  return {
    total,
    winnerCorrect,
    winnerAccuracy: total === 0 ? 0 : winnerCorrect / total,
    scoreMeanAbsoluteError: scored === 0 ? 0 : scoreError / scored,
    disagreements,
  };
}

export type JudgeStabilityReport = {
  readonly caseId: string;
  readonly samples: number;
  readonly winnerAgreement: number;
  readonly scoreVarianceA: number;
  readonly scoreVarianceB: number;
};

export function summarizeJudgeStability(
  reports: readonly JudgePairReport[],
): readonly JudgeStabilityReport[] {
  const byCase = new Map<string, JudgePairReport[]>();
  for (const report of reports) {
    const current = byCase.get(report.caseId) ?? [];
    current.push(report);
    byCase.set(report.caseId, current);
  }
  return [...byCase.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([caseId, samples]) => {
      const first = samples[0] ? resolveWinner(samples[0]) : 'tie';
      const meanA = average(samples.map(({ scoreA }) => scoreA));
      const meanB = average(samples.map(({ scoreB }) => scoreB));
      return {
        caseId,
        samples: samples.length,
        winnerAgreement:
          samples.filter((sample) => resolveWinner(sample) === first).length / samples.length,
        scoreVarianceA: variance(
          samples.map(({ scoreA }) => scoreA),
          meanA,
        ),
        scoreVarianceB: variance(
          samples.map(({ scoreB }) => scoreB),
          meanB,
        ),
      };
    });
}

export type DeterministicJudgeConflict = {
  readonly caseId: string;
  readonly reason: 'winner_mismatch' | 'security_failure';
};

export function findDeterministicJudgeConflicts(
  reports: readonly JudgePairReport[],
  observations: readonly {
    readonly caseId: string;
    readonly winner: 'candidateA' | 'candidateB' | 'tie';
    readonly securityPassed: boolean;
  }[],
): readonly DeterministicJudgeConflict[] {
  const byCase = new Map(observations.map((item) => [item.caseId, item]));
  return reports.flatMap((report) => {
    const observation = byCase.get(report.caseId);
    if (!observation) return [];
    const conflicts: DeterministicJudgeConflict[] = [];
    if (resolveWinner(report) !== observation.winner) {
      conflicts.push({ caseId: report.caseId, reason: 'winner_mismatch' });
    }
    if (!observation.securityPassed) {
      conflicts.push({ caseId: report.caseId, reason: 'security_failure' });
    }
    return conflicts;
  });
}

function resolveWinner(report: JudgePairReport): 'candidateA' | 'candidateB' | 'tie' {
  if (report.winner === 'tie') return 'tie';
  return report.winner === 'a' ? report.displayedA : report.displayedB;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: readonly number[], mean: number): number {
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

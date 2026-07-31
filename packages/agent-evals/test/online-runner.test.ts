import { PiRuntimeAdapter } from '@agentpress/agent-runtime';
import { describe, expect, it } from 'vitest';

import { evalScenarios, parseOnlineEvalDecision, runOnlineEvals } from '../src/index.js';

const directDecision = JSON.stringify({
  mode: 'direct',
  tasks: [],
  taskResult: {
    status: 'completed',
    summary: 'Direct answer is sufficient',
    acceptanceCriteriaPassed: true,
  },
  citations: { requiresEvidence: false, unsupportedClaimsMarkedUncertain: true },
});

const researchDecision = JSON.stringify({
  mode: 'planned',
  tasks: [{ owner: 'researcher', criticality: 'required' }],
  taskResult: {
    status: 'completed',
    summary: 'Research task was delegated',
    acceptanceCriteriaPassed: true,
  },
  citations: { requiresEvidence: true, unsupportedClaimsMarkedUncertain: true },
});

describe('online Agent eval runner', () => {
  it('runs through the injected Pi runtime and records versioned evidence', async () => {
    const scenarios = evalScenarios.filter(({ id }) =>
      ['agentpress-routing-01', 'agentpress-routing-02'].includes(id),
    );
    const report = await runOnlineEvals({
      runtime: PiRuntimeAdapter.forTests({ responses: [directDecision, researchDecision] }),
      model: 'faux-model-for-contract-test',
      scenarios,
      limits: { concurrency: 1, maxScenarios: 2, maxTotalTokens: 1000, maxCostUsd: 1 },
      now: () => new Date('2026-07-31T00:00:00.000Z'),
    });

    expect(report.gatesPassed).toBe(true);
    expect(report.totals.scenarios).toBe(2);
    expect(report.promptVersion).toBe('agentpress-routing-v1');
    expect(report.items.every(({ rawResponse }) => rawResponse.startsWith('{'))).toBe(true);
    expect(report.score).toMatchObject({
      routingAccuracy: 1,
      delegationAccuracy: 1,
      schemaValidity: 1,
    });
  });

  it('rejects markdown-wrapped or shape-drifted model output', () => {
    expect(() => parseOnlineEvalDecision(`\`\`\`json\n${directDecision}\n\`\`\``)).toThrow(
      'strict JSON',
    );
    expect(() =>
      parseOnlineEvalDecision(
        JSON.stringify({ ...JSON.parse(directDecision), reasoning: 'hidden' }),
      ),
    ).toThrow('top-level schema');
  });

  it('fails the schema gate when the runtime response is invalid', async () => {
    const scenario = evalScenarios.find(({ id }) => id === 'agentpress-routing-01');
    if (!scenario) throw new Error('Eval fixture is missing');
    const report = await runOnlineEvals({
      runtime: PiRuntimeAdapter.forTests({ responses: ['not-json'] }),
      model: 'faux-model-for-contract-test',
      scenarios: [scenario],
      limits: { concurrency: 1, maxScenarios: 1, maxTotalTokens: 1000, maxCostUsd: 1 },
    });

    expect(report.gatesPassed).toBe(false);
    expect(report.score.schemaValidity).toBe(0);
    expect(report.items[0]?.error).toBe('Model response is not strict JSON');
  });
});

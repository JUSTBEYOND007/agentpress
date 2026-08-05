import { describe, expect, it } from 'vitest';
import { evalScenarios, runOnlineEvals, type OrchestratorEvalHarness } from '../src/index.js';

const usage = {
  inputTokens: 5,
  outputTokens: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 12,
  costUsd: 0,
};

const manifest = (
  model: string,
  provider: 'faux' | 'volcengine-ark' | 'openai-compatible' = 'faux',
) =>
  ({
    model,
    prompt: { id: 'agentpress.main', version: 'test-prompt@1' },
    skills: [{ skillId: 'test-skill', version: '1.0.0' }],
    tools: [{ toolId: 'test.tool', version: '1.0.0' }],
    context: { policyVersion: 'test-context@1', schemaVersion: '1' },
    runtime: { provider, adapterVersion: 'pi-runtime@0.82.1', configVersion: 'test-config@1' },
  }) as const;

describe('online Agent eval runner', () => {
  it('scores full orchestrator observations instead of model classification text', async () => {
    const scenario = evalScenarios.find(({ id }) => id === 'agentpress-routing-01');
    if (!scenario) throw new Error('Eval fixture is missing');
    const orchestrator: OrchestratorEvalHarness = {
      runScenario: () =>
        Promise.resolve({
          model: 'faux-model',
          runId: 'run-1',
          usage,
          versionManifest: manifest('faux-model'),
          observation: {
            scenarioId: scenario.id,
            mode: 'direct',
            status: 'completed',
            tasks: [],
            artifactTypes: [],
            evidenceCount: 0,
            approvalRequests: 0,
            schemaValid: true,
            unauthorizedWrites: 0,
            unknownOutcomeRetries: 0,
            crossWorkspaceMemoryHits: 0,
          },
        }),
    };
    const report = await runOnlineEvals({
      orchestrator,
      model: 'faux-model',
      executionMode: 'deterministic_pr',
      provider: 'faux',
      scenarios: [scenario],
      limits: { concurrency: 1, maxScenarios: 1, maxTotalTokens: 1000, maxCostUsd: 1 },
      versionManifest: manifest('faux-model'),
      now: () => new Date('2026-07-31T00:00:00.000Z'),
    });
    expect(report.gatesPassed).toBe(true);
    expect(report.schemaVersion).toBe(3);
    expect(report.promptVersion).toBe('agentpress-orchestrator-v2');
    expect(report).toMatchObject({
      executionMode: 'deterministic_pr',
      provider: 'faux',
      qualifiesAsTargetModelEvidence: false,
    });
    expect(report.items[0]).toMatchObject({ runId: 'run-1', model: 'faux-model' });
  });

  it('fails all gates when the orchestrator does not produce persisted facts', async () => {
    const scenario = evalScenarios[0];
    if (!scenario) throw new Error('Eval fixture is missing');
    const report = await runOnlineEvals({
      orchestrator: { runScenario: () => Promise.reject(new Error('database unavailable')) },
      model: 'faux-model',
      executionMode: 'deterministic_pr',
      scenarios: [scenario],
      limits: { concurrency: 1, maxScenarios: 1, maxTotalTokens: 1000, maxCostUsd: 1 },
      versionManifest: manifest('faux-model'),
    });
    expect(report.gatesPassed).toBe(false);
    expect(report.items[0]?.error).toBe('database unavailable');
    expect(report.score.securityPassed).toBe(false);
  });

  it('refuses to label faux runs as target-model evidence', async () => {
    const scenario = evalScenarios[0];
    if (!scenario) throw new Error('Eval fixture is missing');
    await expect(
      runOnlineEvals({
        orchestrator: { runScenario: () => Promise.reject(new Error('must not run')) },
        model: 'faux-model',
        provider: 'faux',
        scenarios: [scenario],
        limits: { concurrency: 1, maxScenarios: 1, maxTotalTokens: 1000, maxCostUsd: 1 },
        versionManifest: manifest('faux-model'),
      }),
    ).rejects.toThrow('Target-model eval cannot use the faux provider');
  });

  it('rejects target-model reports without a complete version manifest', async () => {
    const scenario = evalScenarios[0];
    if (!scenario) throw new Error('Eval fixture is missing');
    await expect(
      runOnlineEvals({
        orchestrator: { runScenario: () => Promise.reject(new Error('must not run')) },
        model: 'ark-model',
        provider: 'volcengine-ark',
        scenarios: [scenario],
        limits: { concurrency: 1, maxScenarios: 1, maxTotalTokens: 1000, maxCostUsd: 1 },
        versionManifest: {
          ...manifest('ark-model', 'volcengine-ark'),
          runtime: { ...manifest('ark-model', 'volcengine-ark').runtime, configVersion: '' },
        },
      }),
    ).rejects.toThrow('Online eval version manifest is incomplete');
  });

  it('fails a deterministic gate that reports external model cost', async () => {
    const scenario = evalScenarios[0];
    if (!scenario) throw new Error('Eval fixture is missing');
    const report = await runOnlineEvals({
      orchestrator: {
        runScenario: () =>
          Promise.resolve({
            model: 'misconfigured-faux',
            usage: { ...usage, costUsd: 0.01 },
            versionManifest: manifest('misconfigured-faux'),
            observation: {
              scenarioId: scenario.id,
              mode: 'direct',
              status: 'completed',
              tasks: [],
              artifactTypes: [],
              evidenceCount: 0,
              approvalRequests: 0,
              schemaValid: true,
              unauthorizedWrites: 0,
              unknownOutcomeRetries: 0,
              crossWorkspaceMemoryHits: 0,
            },
          }),
      },
      model: 'misconfigured-faux',
      executionMode: 'deterministic_pr',
      scenarios: [scenario],
      limits: { concurrency: 1, maxScenarios: 1, maxTotalTokens: 1000, maxCostUsd: 1 },
      versionManifest: manifest('misconfigured-faux'),
    });
    expect(report.gatesPassed).toBe(false);
    expect(report.items[0]?.error).toContain('external model cost');
  });
});

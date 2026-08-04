import type { AgentPressDatabase } from '@agentpress/database';
import { describe, expect, it } from 'vitest';

import { ExperimentStore, summarizePassAtK } from '../src/index.js';

describe('evaluation experiment store policy', () => {
  const store = new ExperimentStore({} as AgentPressDatabase);

  it('rejects empty arms and unbounded attempts before touching persistence', async () => {
    await expect(
      store.createExperiment({
        name: 'routing',
        datasetVersion: 'v1',
        config: {},
        arms: [],
      }),
    ).rejects.toThrow(/at least one arm/u);
    await expect(
      store.enqueueTrials({ armId: 'arm', caseIds: ['case'], attempts: 21, seed: 'seed' }),
    ).rejects.toThrow(/between 1 and 20/u);
  });

  it('computes pass@k per case using deterministic attempt order', () => {
    const trials = [
      { caseId: 'a', attempt: 2, status: 'succeeded' as const },
      { caseId: 'a', attempt: 1, status: 'failed' as const },
      { caseId: 'b', attempt: 1, status: 'failed' as const },
      { caseId: 'b', attempt: 2, status: 'failed' as const },
    ];
    expect(summarizePassAtK(trials, 1)).toEqual({ passed: 0, total: 2, rate: 0 });
    expect(summarizePassAtK(trials, 2)).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(() => summarizePassAtK(trials, 0)).toThrow(/positive k/u);
  });
});

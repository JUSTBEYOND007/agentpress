import type { AgentPressDatabase } from '@agentpress/database';
import { describe, expect, it } from 'vitest';

import { ExperimentStore } from '../src/index.js';

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
});

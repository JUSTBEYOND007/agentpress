import { StaleWorkerSettlementError } from '@agentpress/agent-application';
import { describe, expect, it } from 'vitest';

import { isStaleWorkerSettlementError } from '../src/worker-lifecycle.js';

describe('Agent Run worker settlement boundary', () => {
  it('recognizes only the typed stale lease outcome', () => {
    expect(isStaleWorkerSettlementError(new StaleWorkerSettlementError('run-1'))).toBe(true);
    expect(
      isStaleWorkerSettlementError(
        new Error('Agent Run run-1 rejected stale worker settlement during recovery'),
      ),
    ).toBe(false);
  });
});

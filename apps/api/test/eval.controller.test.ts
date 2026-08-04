import type { ExperimentStore } from '@agentpress/agent-evals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { EvalController } from '../src/eval/eval.controller.js';
import type { AuthorizationService } from '../src/auth/authorization.service.js';

const user = { id: 'user-1', displayName: 'User', subject: 'subject-1' };

describe('EvalController', () => {
  it('lists only experiments from the authorized route workspace', async () => {
    const assertWorkspaceMember = vi.fn().mockResolvedValue(undefined);
    const listWorkspaceExperiments = vi.fn().mockResolvedValue([{ id: 'experiment-1' }]);
    const controller = new EvalController(
      { listWorkspaceExperiments } as unknown as ExperimentStore,
      { assertWorkspaceMember } as unknown as AuthorizationService,
    );

    await expect(controller.listExperiments('workspace-1', '25', user)).resolves.toEqual([
      { id: 'experiment-1' },
    ]);
    expect(listWorkspaceExperiments).toHaveBeenCalledWith('workspace-1', 25);
  });

  it('authorizes and scopes report reads to the route workspace', async () => {
    const assertWorkspaceMember = vi.fn().mockResolvedValue(undefined);
    const getWorkspaceExperimentReport = vi.fn().mockResolvedValue({ id: 'experiment-1' });
    const controller = new EvalController(
      { getWorkspaceExperimentReport } as unknown as ExperimentStore,
      { assertWorkspaceMember } as unknown as AuthorizationService,
    );

    await expect(controller.report('workspace-1', 'experiment-1', user)).resolves.toEqual({
      id: 'experiment-1',
    });
    expect(assertWorkspaceMember).toHaveBeenCalledWith('workspace-1', 'user-1');
    expect(getWorkspaceExperimentReport).toHaveBeenCalledWith('workspace-1', 'experiment-1');
  });

  it('fails closed when a report or trace is not owned by the workspace', async () => {
    const controller = new EvalController(
      {
        getWorkspaceExperimentReport: vi.fn().mockResolvedValue(undefined),
        getWorkspaceTrialTrace: vi.fn().mockResolvedValue(undefined),
      } as unknown as ExperimentStore,
      { assertWorkspaceMember: vi.fn() } as unknown as AuthorizationService,
    );

    await expect(controller.report('workspace-1', 'foreign', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.trace('workspace-1', 'foreign', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('validates trend parameters before querying the store', async () => {
    const listRegressionTrend = vi.fn();
    const controller = new EvalController(
      { listRegressionTrend } as unknown as ExperimentStore,
      { assertWorkspaceMember: vi.fn() } as unknown as AuthorizationService,
    );

    await expect(
      controller.regressionTrend(
        'workspace-1',
        undefined,
        'baseline',
        'succeeded',
        undefined,
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.regressionTrend('workspace-1', 'routing', 'baseline', 'succeeded', '1.5', user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(listRegressionTrend).not.toHaveBeenCalled();
  });
});

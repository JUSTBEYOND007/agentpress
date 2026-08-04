import { ToolRegistry } from '@agentpress/tool-runtime';
import { describe, expect, it } from 'vitest';

import {
  ContextGovernanceService,
  registerContextTools,
} from '../src/context-governance-service.js';

const validCandidate = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  status: 'pending' as const,
  subject: 'tone',
  value: 'Use a neutral tone',
  confidenceBps: 9_500,
};

describe('context governance tools', () => {
  it('validates the structured Memory Candidate output', async () => {
    const registry = memoryRegistry(() => Promise.resolve(validCandidate));

    await expect(executeMemoryTool(registry)).resolves.toEqual(validCandidate);
  });

  it('fails closed when a Memory Candidate output does not satisfy the contract', async () => {
    const registry = memoryRegistry(() =>
      Promise.resolve({ ...validCandidate, status: 'invented-state' }),
    );

    const execution = executeMemoryTool(registry);
    await expect(execution).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });
});

function memoryRegistry(
  proposeMemoryForRun: (...arguments_: never[]) => Promise<unknown>,
): ToolRegistry {
  const registry = new ToolRegistry();
  registerContextTools(registry, { proposeMemoryForRun } as unknown as ContextGovernanceService);
  return registry;
}

function executeMemoryTool(registry: ToolRegistry): Promise<unknown> {
  return registry.execute(
    registry.get('memory.propose', '1.0.0'),
    { subject: 'tone', value: 'Use a neutral tone', confidence: 0.95 },
    { runId: 'run-1', toolCallId: 'call-1' },
  );
}

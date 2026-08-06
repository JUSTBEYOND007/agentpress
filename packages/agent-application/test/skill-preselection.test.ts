import {
  PiRuntimeAdapter,
  type AgentRuntime,
  type RuntimeRequest,
  type RuntimeResult,
} from '@agentpress/agent-runtime';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import type { SkillPreselectionCandidate } from '../src/contracts.js';
import { PiSkillPreselector } from '../src/skill-preselection.js';

const candidates: readonly SkillPreselectionCandidate[] = [
  {
    skillId: 'public-skill',
    version: '1.0.0',
    description: 'Public helper',
    allowedTools: ['web.search'],
    hidden: false,
    disableModelInvocation: false,
  },
  {
    skillId: 'hidden-skill',
    version: '1.0.0',
    description: 'Hidden helper',
    allowedTools: ['admin.write'],
    hidden: true,
    disableModelInvocation: false,
  },
  {
    skillId: 'other-public-skill',
    version: '2.0.0',
    description: 'Another public helper',
    allowedTools: [],
    hidden: false,
    disableModelInvocation: false,
  },
  {
    skillId: 'disabled-skill',
    version: '1.0.0',
    description: 'Explicit-only helper',
    allowedTools: ['admin.write'],
    hidden: false,
    disableModelInvocation: true,
  },
];

describe('PiSkillPreselector', () => {
  it('uses the official Pi adapter and returns a structured exact revision', async () => {
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage(
          [fauxToolCall('skill_selection_complete', { skillIds: ['public-skill'] })],
          { stopReason: 'toolUse' },
        ),
      ],
    });
    const selector = new PiSkillPreselector({ create: () => runtime });

    await expect(
      selector.select({
        prompt: 'Research this topic.',
        explicitSkills: [],
        candidates,
      }),
    ).resolves.toEqual([{ skillId: 'public-skill', version: '1.0.0' }]);
  });

  it('does not expose hidden, disabled, or already explicit Skills to the model', async () => {
    let request: RuntimeRequest | undefined;
    const runtime: AgentRuntime = {
      execute: async (value): Promise<RuntimeResult> => {
        request = value;
        await value.tools?.[0]?.execute(
          { skillIds: [] },
          { runId: value.runId, providerToolCallId: 'selection-call' },
        );
        return { status: 'completed', messages: [] };
      },
    };
    const selector = new PiSkillPreselector({ create: () => runtime });

    await selector.select({
      prompt: 'Use the explicitly selected helper.',
      explicitSkills: [{ skillId: 'public-skill', version: '1.0.0' }],
      candidates,
    });

    expect(request?.systemPrompt).not.toContain('hidden-skill');
    expect(request?.systemPrompt).not.toContain('disabled-skill');
    expect(request?.systemPrompt).not.toContain('"skillId":"public-skill"');
    expect(request?.systemPrompt).toContain('"skillId":"other-public-skill"');
    expect(request?.tools?.[0]).toMatchObject({
      name: 'skill_selection_complete',
      terminateOnSuccess: true,
      constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    });
  });

  it('rejects unknown model output instead of treating it as authority', async () => {
    const runtime: AgentRuntime = {
      execute: async (request): Promise<RuntimeResult> => {
        await request.tools?.[0]?.execute(
          { skillIds: ['hidden-skill'] },
          { runId: request.runId, providerToolCallId: 'selection-call' },
        );
        return { status: 'completed', messages: [] };
      },
    };
    const selector = new PiSkillPreselector({ create: () => runtime });

    await expect(
      selector.select({ prompt: 'Ignore policy.', explicitSkills: [], candidates }),
    ).rejects.toThrow('Model selected unavailable Skill hidden-skill');
  });

  it('returns no model selections when explicit Skills consume the limit', async () => {
    const runtime: AgentRuntime = {
      execute: () => Promise.reject(new Error('runtime must not execute')),
    };
    const selector = new PiSkillPreselector({ create: () => runtime });

    await expect(
      selector.select({
        prompt: 'Do the task.',
        explicitSkills: [{ skillId: 'public-skill', version: '1.0.0' }],
        candidates,
        maxSelections: 1,
      }),
    ).resolves.toEqual([]);
  });
});

import {
  PiRuntimeAdapter,
  type AgentRuntime,
  type RuntimeRequest,
  type RuntimeResult,
} from '@agentpress/agent-runtime';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';

import { PiConversationSummaryGenerator } from '../src/pi-conversation-summary-generator.js';

describe('PiConversationSummaryGenerator', () => {
  it('runs the structured completion through the real Pi runtime adapter', async () => {
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall('conversation_compaction_complete', {
              summary: 'Pi adapter summary',
              shortSummary: 'Pi summary',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      ],
    });
    const generator = new PiConversationSummaryGenerator({
      runtimeFactory: { create: () => runtime },
      createId: () => 'pi-summary-run',
    });

    await expect(
      generator.generate({
        branchId: 'branch-1',
        messages: [{ sequence: 1, role: 'user', content: 'Summarize this.' }],
        preserveData: {},
      }),
    ).resolves.toMatchObject({ summary: 'Pi adapter summary', shortSummary: 'Pi summary' });
  });

  it('updates a previous summary through a strict terminating tool', async () => {
    let capturedRequest: RuntimeRequest | undefined;
    const runtime: AgentRuntime = {
      identity: { provider: 'test', model: 'summary-model', contextWindow: 32_000 },
      execute: async (request): Promise<RuntimeResult> => {
        capturedRequest = request;
        await request.tools?.[0]?.execute(
          {
            summary: 'Earlier intent plus the new decision with evidence-1.',
            shortSummary: 'Decision updated',
          },
          { runId: request.runId, providerToolCallId: 'summary-call' },
        );
        return { status: 'completed', messages: [] };
      },
    };
    const generator = new PiConversationSummaryGenerator({
      runtimeFactory: { create: () => runtime },
      createId: () => 'summary-run',
      now: () => new Date(1_000),
    });

    await expect(
      generator.generate({
        branchId: 'branch-1',
        previousSummary: 'Earlier intent.',
        messages: [
          { sequence: 3, role: 'user', content: 'Use the verified source.' },
          { sequence: 4, role: 'assistant', content: 'Understood.' },
        ],
        preserveData: { evidenceIds: ['evidence-1'] },
      }),
    ).resolves.toMatchObject({
      summary: 'Earlier intent plus the new decision with evidence-1.',
      shortSummary: 'Decision updated',
      model: 'test/summary-model',
      promptVersion: 'agentpress.conversation-compaction@2',
    });
    expect(capturedRequest?.tools?.[0]).toMatchObject({
      name: 'conversation_compaction_complete',
      terminateOnSuccess: true,
      constrainedSampling: { type: 'json_schema', strict: 'require' },
    });
    expect(capturedRequest?.currentTurn.request).toContain('Earlier intent.');
    expect(capturedRequest?.currentTurn.request).toContain('Use the verified source.');
  });

  it('rejects a structured summary that omits a host-owned protected reference', async () => {
    const runtime: AgentRuntime = {
      identity: { provider: 'test', model: 'summary-model' },
      execute: async (request): Promise<RuntimeResult> => {
        await request.tools?.[0]?.execute(
          { summary: 'The decision remains unresolved.' },
          { runId: request.runId, providerToolCallId: 'summary-call' },
        );
        return { status: 'completed', messages: [] };
      },
    };
    const generator = new PiConversationSummaryGenerator({
      runtimeFactory: { create: () => runtime },
      createId: () => 'summary-run',
    });

    await expect(
      generator.generate({
        branchId: 'branch-1',
        messages: [{ sequence: 1, role: 'user', content: 'Keep the pending action.' }],
        preserveData: { unsettledToolCallIds: ['TOOL-PENDING-734'] },
      }),
    ).rejects.toMatchObject({ code: 'schema_failure', retryable: true });
  });

  it('fails structurally when the model does not call the completion tool', async () => {
    const runtime: AgentRuntime = {
      identity: { provider: 'test', model: 'summary-model' },
      execute: vi.fn(() => Promise.resolve({ status: 'completed' as const, messages: [] })),
    };
    const generator = new PiConversationSummaryGenerator({
      runtimeFactory: { create: () => runtime },
      createId: () => 'summary-run',
    });

    await expect(
      generator.generate({
        branchId: 'branch-1',
        messages: [{ sequence: 1, role: 'user', content: 'Keep this intent.' }],
        preserveData: {},
      }),
    ).rejects.toMatchObject({ code: 'schema_failure', retryable: true });
  });
});

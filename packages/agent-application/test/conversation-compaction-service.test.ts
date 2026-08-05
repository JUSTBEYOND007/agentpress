import type { AppendConversationCompactionInput } from '@agentpress/database';
import { describe, expect, it } from 'vitest';

import {
  ConversationCompactionService,
  type ConversationCompactionPersistence,
  type ConversationSummaryGenerator,
} from '../src/conversation-compaction-service.js';
import { ConversationSummaryGenerationError } from '../src/pi-conversation-summary-generator.js';

describe('ConversationCompactionService', () => {
  it('summarizes only the planned range and persists host-owned preserve data', async () => {
    const appended: AppendConversationCompactionInput[] = [];
    const persistence = fakePersistence(appended);
    const generatedInputs: Parameters<ConversationSummaryGenerator['generate']>[0][] = [];
    const generate: ConversationSummaryGenerator['generate'] = (input) => {
      generatedInputs.push(input);
      return Promise.resolve({
        summary: 'Durable updated summary',
        shortSummary: 'Updated',
        tokenCount: 8,
        model: 'test/summary',
        promptVersion: 'agentpress.conversation-compaction@2' as const,
      });
    };
    const service = new ConversationCompactionService({
      persistence,
      generator: { generate },
      contextWindow: 1_000,
      keepRecentTokens: 2,
      reserveTokens: 100,
      createId: () => 'compaction-1',
    });

    await expect(
      service.compact({ branchId: 'branch-1', reason: 'manual', force: true }),
    ).resolves.toEqual({ status: 'completed', compactionId: 'compaction-1', version: 1 });
    expect(generatedInputs[0]).toMatchObject({
      branchId: 'branch-1',
      preserveData: { evidenceIds: ['evidence-1'], unsettledToolCallIds: ['tool-1'] },
    });
    expect(generatedInputs[0]?.messages.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(appended[0]).toMatchObject({
      sourceFromSequence: 1,
      sourceThroughSequence: 4,
      firstKeptMessageSequence: 5,
      preserveData: { evidenceIds: ['evidence-1'], unsettledToolCallIds: ['tool-1'] },
    });
  });

  it('records a recoverable failed attempt without manufacturing a summary', async () => {
    const appended: AppendConversationCompactionInput[] = [];
    const service = new ConversationCompactionService({
      persistence: fakePersistence(appended),
      generator: {
        generate: () =>
          Promise.reject(
            new ConversationSummaryGenerationError(
              'schema_failure',
              'No structured output',
              true,
              'test/summary',
            ),
          ),
      },
      contextWindow: 1_000,
      keepRecentTokens: 2,
      reserveTokens: 100,
      createId: () => 'failed-compaction',
    });

    await expect(
      service.compact({ branchId: 'branch-1', reason: 'mid_turn', force: true }),
    ).resolves.toEqual({ status: 'failed', compactionId: 'failed-compaction', version: 1 });
    expect(appended[0]).toMatchObject({
      failure: { code: 'schema_failure', message: 'No structured output', retryable: true },
      preserveData: { evidenceIds: ['evidence-1'], unsettledToolCallIds: ['tool-1'] },
    });
    expect(appended[0]).not.toHaveProperty('summary');
  });

  it('does not call the model below the automatic threshold', async () => {
    let called = false;
    const generate: ConversationSummaryGenerator['generate'] = () => {
      called = true;
      return Promise.reject(new Error('The generator must not run below the threshold'));
    };
    const service = new ConversationCompactionService({
      persistence: fakePersistence([]),
      generator: { generate },
      contextWindow: 10_000,
      reserveTokens: 1_000,
      keepRecentTokens: 2,
    });

    await expect(service.compact({ branchId: 'branch-1', reason: 'automatic' })).resolves.toEqual({
      status: 'not_needed',
      reason: 'below_threshold',
    });
    expect(called).toBe(false);
  });

  it('records timeout separately from user cancellation', async () => {
    const appended: AppendConversationCompactionInput[] = [];
    const service = new ConversationCompactionService({
      persistence: fakePersistence(appended),
      generator: {
        generate: ({ signal }) =>
          new Promise((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                reject(
                  new ConversationSummaryGenerationError(
                    'cancelled',
                    'aborted',
                    true,
                    'test/summary',
                  ),
                );
              },
              { once: true },
            );
          }),
      },
      contextWindow: 1_000,
      keepRecentTokens: 2,
      reserveTokens: 100,
      timeoutMs: 1,
      createId: () => 'timeout-compaction',
    });

    await expect(
      service.compact({ branchId: 'branch-1', reason: 'automatic', force: true }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(appended[0]).toMatchObject({
      failure: {
        code: 'timeout',
        message: 'Conversation summary generation timed out',
        retryable: true,
      },
    });
  });

  it('records user cancellation without replacing the raw timeline with a summary', async () => {
    const appended: AppendConversationCompactionInput[] = [];
    const controller = new AbortController();
    controller.abort();
    const service = new ConversationCompactionService({
      persistence: fakePersistence(appended),
      generator: {
        generate: ({ signal }) =>
          Promise.reject(
            new ConversationSummaryGenerationError(
              signal?.aborted ? 'cancelled' : 'provider_failure',
              'Conversation compaction was cancelled',
              true,
              'test/summary',
            ),
          ),
      },
      contextWindow: 1_000,
      keepRecentTokens: 2,
      reserveTokens: 100,
      createId: () => 'cancelled-compaction',
    });

    await expect(
      service.compact({
        branchId: 'branch-1',
        reason: 'manual',
        force: true,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: 'failed', compactionId: 'cancelled-compaction', version: 1 });
    expect(appended[0]).toMatchObject({
      failure: { code: 'cancelled', retryable: true },
      preserveData: { evidenceIds: ['evidence-1'], unsettledToolCallIds: ['tool-1'] },
    });
    expect(appended[0]).not.toHaveProperty('summary');
  });
});

function fakePersistence(
  appended: AppendConversationCompactionInput[],
): ConversationCompactionPersistence {
  return {
    loadMessages: () =>
      Promise.resolve(
        Array.from({ length: 6 }, (_, index) => ({
          sequence: index + 1,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: [
            {
              type: 'agentpress.runtime-message',
              message: { content: index % 2 === 0 ? `u${String(index)}` : `a${String(index)}` },
            },
          ],
        })),
      ),
    getEffective: () => Promise.resolve(undefined),
    collectPreserveData: () =>
      Promise.resolve({ evidenceIds: ['evidence-1'], unsettledToolCallIds: ['tool-1'] }),
    append: (input) => {
      appended.push(input);
      return Promise.resolve({ id: input.id, version: 1 });
    },
  };
}

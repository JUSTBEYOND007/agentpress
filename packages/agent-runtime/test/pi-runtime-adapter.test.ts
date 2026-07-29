import { describe, expect, it } from 'vitest';

import { createArkBackend, PiRuntimeAdapter, type RuntimeEvent } from '../src/index.js';

describe('PiRuntimeAdapter', () => {
  it('registers explicit Ark credentials with the Pi model registry', async () => {
    const backend = createArkBackend({ modelId: 'ark-endpoint', apiKey: 'test-key' });

    await expect(backend.models.getAuth(backend.model)).resolves.toMatchObject({
      auth: { apiKey: 'test-key' },
    });
  });

  it('maps official Pi streaming events into stable AgentPress events', async () => {
    const runtime = PiRuntimeAdapter.forTests({ responses: ['第一轮回答。', '第二轮回答。'] });
    const firstEvents: RuntimeEvent[] = [];
    const first = await runtime.execute(
      {
        runId: 'run-1',
        systemPrompt: 'You are a writing assistant.',
        history: [],
        prompt: '第一问',
      },
      (event) => {
        firstEvents.push(event);
      },
    );

    expect(first.status).toBe('completed');
    expect(first.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '第一轮回答。',
      provider: 'faux',
    });
    expect(firstEvents.some(({ type }) => type === 'content.delta')).toBe(true);
    expect(firstEvents.at(-1)?.type).toBe('run.completed');

    const second = await runtime.execute(
      {
        runId: 'run-2',
        systemPrompt: 'You are a writing assistant.',
        history: first.messages,
        prompt: '第二问',
      },
      () => undefined,
    );
    expect(second.messages).toHaveLength(2);
    expect(second.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '第二轮回答。',
    });
  });

  it('maps AbortSignal to Pi cancellation', async () => {
    const runtime = PiRuntimeAdapter.forTests({
      responses: ['这段回复不应该完整输出。'],
      tokensPerSecond: 1,
    });
    const controller = new AbortController();
    const execution = runtime.execute(
      {
        runId: 'run-cancel',
        systemPrompt: 'You are a writing assistant.',
        history: [],
        prompt: '开始',
      },
      (event) => {
        if (event.type === 'content.delta') {
          controller.abort();
        }
      },
      controller.signal,
    );

    await expect(execution).resolves.toMatchObject({ status: 'cancelled' });
  });
});

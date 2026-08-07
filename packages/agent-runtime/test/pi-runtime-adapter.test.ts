import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import {
  createArkBackend,
  createOpenAICompatibleBackend,
  PiRuntimeAdapter,
  RUNTIME_CURRENT_TURN_VERSION,
  type RuntimeCurrentTurn,
  type RuntimeEvent,
  validateRuntimeHistory,
} from '../src/index.js';

function currentTurn(request: string): RuntimeCurrentTurn {
  return {
    type: 'agentpress_current_turn',
    version: RUNTIME_CURRENT_TURN_VERSION,
    source: 'user',
    request,
    actionEnvelope: { version: 1, source: 'free_text', grantedCapabilities: [] },
    timestamp: 1,
  };
}

describe('PiRuntimeAdapter', () => {
  it('exposes the actual provider and model identity', () => {
    const { identity } = PiRuntimeAdapter.forTests({ responses: [] });
    expect(identity.provider).toBeTypeOf('string');
    expect(identity.model).toBeTypeOf('string');
  });
  it('registers explicit Ark credentials with the Pi model registry', async () => {
    const backend = createArkBackend({ modelId: 'ark-endpoint', apiKey: 'test-key' });

    await expect(backend.models.getAuth(backend.model)).resolves.toMatchObject({
      auth: { apiKey: 'test-key' },
    });
  });

  it('registers an independently named OpenAI-compatible provider', async () => {
    const backend = createOpenAICompatibleBackend({
      providerId: 'agent-model',
      providerName: 'Agent model',
      modelId: 'gpt-compatible',
      baseUrl: 'https://models.example/v1',
      apiKey: 'test-key',
      acceptsStrictTools: true,
      enforcesStrictTools: true,
    });

    expect(backend.model).toMatchObject({
      provider: 'agent-model',
      id: 'gpt-compatible',
      baseUrl: 'https://models.example/v1',
    });
    expect(backend.toolSchemaCapability).toEqual({
      dialect: 'openai',
      acceptsStrictTools: true,
      enforcesStrictTools: true,
    });
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
        currentTurn: currentTurn('第一问'),
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
        currentTurn: currentTurn('第二问'),
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
        currentTurn: currentTurn('开始'),
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

  it('applies a host-owned per-request output token budget', async () => {
    const streamOptions: Readonly<Record<string, unknown>>[] = [];
    const runtime = PiRuntimeAdapter.forTests({
      responses: ['Bounded output.'],
      maxOutputTokens: 100,
      onStreamOptions: (options) => streamOptions.push(options),
    });
    const result = await runtime.execute(
      {
        runId: 'bounded-output',
        systemPrompt: 'Respond within the host budget.',
        history: [],
        currentTurn: currentTurn('respond'),
        maxOutputTokens: 40,
      },
      () => undefined,
    );

    expect(result.status).toBe('completed');
    expect(streamOptions).toEqual([expect.objectContaining({ maxTokens: 40 })]);
  });

  it('fails closed when a request output budget exceeds the selected model', async () => {
    const events: RuntimeEvent[] = [];
    const runtime = PiRuntimeAdapter.forTests({ responses: [], maxOutputTokens: 100 });
    const result = await runtime.execute(
      {
        runId: 'invalid-output-budget',
        systemPrompt: 'Do not run.',
        history: [],
        currentTurn: currentTurn('respond'),
        maxOutputTokens: 101,
      },
      (event) => {
        events.push(event);
      },
    );

    expect(result).toMatchObject({ status: 'failed', error: { code: 'protocol_error' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'run.failed', error: { code: 'protocol_error' } });
  });

  it('compacts oversized persisted history before the first provider request', async () => {
    const calls: unknown[] = [];
    const runtime = PiRuntimeAdapter.forTests({
      responses: ['Recovered after preflight compaction.'],
      contextWindow: 1_000,
      maxOutputTokens: 100,
    });
    const result = await runtime.execute(
      {
        runId: 'preflight-overflow',
        systemPrompt: 'Continue safely.',
        history: [
          { role: 'user', content: 'a'.repeat(3_000), timestamp: 1 },
          { role: 'user', content: 'b'.repeat(3_000), timestamp: 2 },
          { role: 'user', content: 'recent', timestamp: 3 },
        ],
        currentTurn: currentTurn('continue'),
        compactContext: (request) => {
          calls.push(request);
          return Promise.resolve({
            status: 'completed',
            compactionId: 'session-compaction-1',
            summary: 'Earlier persisted history.',
            firstKeptMessageIndex: 2,
            tokensBefore: 900,
            tokenCount: 8,
          });
        },
      },
      () => undefined,
    );

    expect(result).toMatchObject({ status: 'completed' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ reason: 'overflow', runId: 'preflight-overflow' });
  });

  it('compacts in place after a complete ToolCall turn and continues the same Pi execute', async () => {
    const compactions: {
      readonly reason: string;
      readonly messages: readonly { readonly role: string; readonly toolCallId?: string }[];
    }[] = [];
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([fauxToolCall('lookup', { key: 'large' }, { id: 'mid-call' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxText('Finished after mid-turn compaction.')]),
      ],
      contextWindow: 10_000,
      maxOutputTokens: 100,
    });
    const result = await runtime.execute(
      {
        runId: 'mid-turn-compaction',
        systemPrompt: 'Use the tool and continue.',
        history: [
          { role: 'user', content: 'a'.repeat(17_500), timestamp: 1 },
          { role: 'user', content: 'b'.repeat(17_500), timestamp: 2 },
        ],
        currentTurn: currentTurn('lookup'),
        tools: [
          {
            name: 'lookup',
            label: 'Lookup',
            description: 'Return a large result.',
            parameters: Type.Object({ key: Type.String() }),
            execute: () => Promise.resolve({ content: 'x'.repeat(8_000) }),
          },
        ],
        compactContext: (request) => {
          compactions.push(request);
          return Promise.resolve({
            status: 'completed',
            compactionId: 'session-compaction-2',
            summary: 'Current request and earlier completed work.',
            firstKeptMessageIndex: 3,
            tokensBefore: 1_400,
            tokenCount: 12,
          });
        },
      },
      () => undefined,
    );

    expect(result).toMatchObject({ status: 'completed' });
    expect(result.messages.at(-1)).toMatchObject({
      content: 'Finished after mid-turn compaction.',
    });
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.reason).toBe('mid_turn');
    expect(compactions[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'tool', toolCallId: 'mid-call' }),
      ]),
    );
  });

  it('keeps a provider overflow error durable while retrying once after persisted compaction', async () => {
    const reasons: string[] = [];
    const streamOptions: Readonly<Record<string, unknown>>[] = [];
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'context_length_exceeded: input is too long',
        }),
        fauxAssistantMessage([fauxText('Recovered from provider overflow.')]),
      ],
      contextWindow: 10_000,
      maxOutputTokens: 100,
      onStreamOptions: (options) => streamOptions.push(options),
    });
    const result = await runtime.execute(
      {
        runId: 'provider-overflow',
        systemPrompt: 'Recover once.',
        history: [
          { role: 'user', content: 'a'.repeat(5_000), timestamp: 1 },
          { role: 'user', content: 'b'.repeat(5_000), timestamp: 2 },
        ],
        currentTurn: currentTurn('recover'),
        toolChoice: 'none',
        compactContext: (request) => {
          reasons.push(request.reason);
          return Promise.resolve({
            status: 'completed',
            compactionId: 'provider-overflow-compaction',
            summary: 'Earlier context was compacted before retry.',
            firstKeptMessageIndex: 1,
            tokensBefore: 2_600,
            tokenCount: 10,
          });
        },
      },
      () => undefined,
    );

    expect(result).toMatchObject({ status: 'completed' });
    expect(result.messages.at(-1)).toMatchObject({ content: 'Recovered from provider overflow.' });
    expect(reasons).toEqual(['overflow']);
    expect(streamOptions.map(({ toolChoice }) => toolChoice)).toEqual(['none', 'none']);
  });

  it('does not retry or hide the provider overflow when compaction fails', async () => {
    let compactions = 0;
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'prompt is too long: 12000 tokens > 10000 maximum',
        }),
        fauxAssistantMessage([fauxText('must not be consumed')]),
      ],
      contextWindow: 10_000,
      maxOutputTokens: 100,
    });
    const result = await runtime.execute(
      {
        runId: 'provider-overflow-failed-compaction',
        systemPrompt: 'Fail closed.',
        history: [
          { role: 'user', content: 'a'.repeat(2_000), timestamp: 1 },
          { role: 'user', content: 'b'.repeat(2_000), timestamp: 2 },
        ],
        currentTurn: currentTurn('recover'),
        compactContext: () => {
          compactions += 1;
          return Promise.resolve({
            status: 'failed',
            compactionId: 'failed-compaction',
            message: 'summary provider unavailable',
          });
        },
      },
      () => undefined,
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('provider_error');
      expect(result.error.message).toContain('prompt is too long');
    }
    expect(compactions).toBe(1);
  });

  it('bridges AgentPress RuntimeTool definitions into the official Pi tool loop', async () => {
    const calls: {
      readonly arguments_: Readonly<Record<string, unknown>>;
      readonly context: {
        readonly runId: string;
        readonly providerToolCallId: string;
        readonly signal?: AbortSignal;
      };
    }[] = [];
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([fauxToolCall('workspace_search', { query: 'Kafka' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxText('已找到工作区证据。')]),
      ],
    });
    const result = await runtime.execute(
      {
        runId: 'run-tool',
        systemPrompt: 'Use tools when evidence is required.',
        history: [],
        currentTurn: currentTurn('查找 Kafka 资料'),
        tools: [
          {
            name: 'workspace_search',
            label: 'Workspace Search',
            description: 'Search workspace evidence',
            parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }),
            execute: (arguments_, context) => {
              calls.push({ arguments_, context });
              return Promise.resolve({ evidence: ['Kafka architecture'] });
            },
          },
        ],
      },
      () => undefined,
    );

    expect(result.status).toBe('completed');
    expect(result.messages.at(-1)).toMatchObject({ content: '已找到工作区证据。' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments_).toEqual({ query: 'Kafka' });
    expect(calls[0]?.context.runId).toBe('run-tool');
    expect(typeof calls[0]?.context.providerToolCallId).toBe('string');
  });

  it('serves a persisted forced tool choice once, then releases it for the follow-up turn', async () => {
    const streamOptions: Readonly<Record<string, unknown>>[] = [];
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([fauxToolCall('lookup', { key: 'a' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxText('done')]),
      ],
      onStreamOptions: (options) => streamOptions.push(options),
    });
    await runtime.execute(
      {
        runId: 'forced-choice',
        systemPrompt: 'Use the selected tool.',
        history: [],
        currentTurn: currentTurn('查询'),
        toolChoice: { type: 'tool', name: 'lookup' },
        tools: [
          {
            name: 'lookup',
            label: 'Lookup',
            description: 'Lookup one key',
            parameters: Type.Object({ key: Type.String() }),
            execute: () => Promise.resolve({ ok: true }),
          },
        ],
      },
      () => undefined,
    );
    expect(streamOptions[0]?.toolChoice).toEqual({ type: 'tool', name: 'lookup' });
    expect(streamOptions[1]?.toolChoice).toBeUndefined();
  });

  it('executes parallel provider ToolCalls exactly once and preserves both results', async () => {
    const executions: string[] = [];
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall('lookup', { key: 'a' }, { id: 'parallel-a' }),
            fauxToolCall('lookup', { key: 'b' }, { id: 'parallel-b' }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxText('Merged both results.')]),
      ],
    });
    const completed: RuntimeEvent[] = [];
    const result = await runtime.execute(
      {
        runId: 'run-parallel-tools',
        systemPrompt: 'Use both lookups.',
        history: [],
        currentTurn: currentTurn('lookup a and b'),
        tools: [
          {
            name: 'lookup',
            label: 'Lookup',
            description: 'Lookup one key',
            parameters: Type.Object({ key: Type.String() }, { additionalProperties: false }),
            executionMode: 'parallel',
            execute: ({ key }) => {
              executions.push(String(key));
              return Promise.resolve({ key });
            },
          },
        ],
      },
      (event) => {
        if (event.type === 'tool.completed') completed.push(event);
      },
    );
    expect(result.status).toBe('completed');
    expect(executions.sort()).toEqual(['a', 'b']);
    expect(completed).toHaveLength(2);
    expect(
      completed.flatMap((event) =>
        event.type === 'tool.completed' ? [event.result.toolCallId] : [],
      ),
    ).toEqual(expect.arrayContaining(['parallel-a', 'parallel-b']));
  });

  it('rebuilds a Pi transcript and continues after a persisted tool result', async () => {
    const runtime = PiRuntimeAdapter.forTests({ responses: ['恢复后的最终回答。'] });
    const result = await runtime.execute(
      {
        runId: 'session-recovered',
        systemPrompt: 'Continue from persisted PostgreSQL transcript entries.',
        history: [
          {
            role: 'assistant',
            content: '',
            blocks: [
              {
                type: 'tool_call',
                id: 'provider-call-1',
                name: 'workspace_search',
                arguments: { query: 'Pi recovery' },
              },
            ],
            provider: 'faux',
            model: 'faux-model',
            stopReason: 'tool_use',
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 0,
              costUsd: 0,
            },
            timestamp: 1,
          },
          {
            role: 'tool',
            toolCallId: 'provider-call-1',
            toolName: 'workspace_search',
            content: '{"evidence":["persisted"]}',
            details: { evidence: ['persisted'] },
            isError: false,
            timestamp: 2,
          },
        ],
        currentTurn: currentTurn(''),
      },
      () => undefined,
    );

    expect(result.status).toBe('completed');
    expect(result.messages.at(-1)).toMatchObject({ content: '恢复后的最终回答。' });
  });

  it('fails closed for missing, duplicate, and mismatched persisted ToolResults', async () => {
    const assistant = {
      role: 'assistant' as const,
      content: '',
      blocks: [
        {
          type: 'tool_call' as const,
          id: 'history-call',
          name: 'lookup',
          arguments: { key: 'a' },
        },
      ],
      provider: 'prior-provider',
      model: 'prior-model',
      stopReason: 'tool_use' as const,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
      timestamp: 1,
    };
    const toolResult = {
      role: 'tool' as const,
      toolCallId: 'history-call',
      toolName: 'lookup',
      content: '{}',
      isError: false,
      timestamp: 2,
    };
    expect(validateRuntimeHistory([assistant])).toMatchObject({ code: 'invalid_history' });
    expect(validateRuntimeHistory([assistant, toolResult, toolResult])).toMatchObject({
      code: 'invalid_history',
    });
    expect(validateRuntimeHistory([assistant, { ...toolResult, toolName: 'other' }])).toMatchObject(
      { code: 'invalid_history' },
    );

    const runtime = PiRuntimeAdapter.forTests({ responses: ['should not be called'] });
    const result = await runtime.execute(
      {
        runId: 'invalid-history',
        systemPrompt: 'Continue safely.',
        history: [assistant],
        currentTurn: currentTurn(''),
        continuation: true,
      },
      () => undefined,
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'invalid_history' } });
  });

  it('lets the official Pi loop convert partial JSON into an error ToolResult without execution', async () => {
    let executions = 0;
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall('lookup', '{"key":"a"' as unknown as Readonly<Record<string, unknown>>, {
              id: 'partial-call',
            }),
          ],
          { stopReason: 'length' },
        ),
        fauxAssistantMessage([fauxText('已重新发起。')]),
      ],
    });
    const completed: RuntimeEvent[] = [];
    const result = await runtime.execute(
      {
        runId: 'partial-json',
        systemPrompt: 'Retry malformed tool arguments.',
        history: [],
        currentTurn: currentTurn('查询'),
        tools: [
          {
            name: 'lookup',
            label: 'Lookup',
            description: 'Lookup one key',
            parameters: Type.Object({ key: Type.String() }),
            execute: () => {
              executions += 1;
              return Promise.resolve({ ok: true });
            },
          },
        ],
      },
      (event) => {
        if (event.type === 'tool.completed') completed.push(event);
      },
    );
    expect(result).toMatchObject({ status: 'completed' });
    expect(executions).toBe(0);
    expect(completed[0]).toMatchObject({
      type: 'tool.completed',
      result: { toolCallId: 'partial-call', isError: true },
    });
  });

  it('preserves provider switching and handles aborted thinking and empty stops', async () => {
    const switching = await PiRuntimeAdapter.forTests({ responses: ['继续完成。'] }).execute(
      {
        runId: 'provider-switch',
        systemPrompt: 'Continue after provider migration.',
        history: [
          {
            role: 'assistant',
            content: '旧模型回答',
            provider: 'old-provider',
            model: 'old-model',
            stopReason: 'stop',
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 2,
              costUsd: 0,
            },
            timestamp: 1,
          },
        ],
        currentTurn: currentTurn('继续'),
      },
      () => undefined,
    );
    expect(switching).toMatchObject({ status: 'completed' });

    const aborted = await PiRuntimeAdapter.forTests({
      responses: [fauxAssistantMessage([fauxThinking('未完成思考')], { stopReason: 'aborted' })],
    }).execute(
      {
        runId: 'aborted-thinking',
        systemPrompt: 'Do not expose incomplete thinking.',
        history: [],
        currentTurn: currentTurn('开始'),
      },
      () => undefined,
    );
    expect(aborted.status).toBe('cancelled');

    const empty = await PiRuntimeAdapter.forTests({
      responses: [fauxAssistantMessage([], { stopReason: 'stop' })],
    }).execute(
      {
        runId: 'empty-stop',
        systemPrompt: 'Empty stop is still a provider response.',
        history: [],
        currentTurn: currentTurn('开始'),
      },
      () => undefined,
    );
    expect(empty).toMatchObject({ status: 'completed' });

    const unexpected = await PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage('provider ended with an unknown stop', {
          stopReason: 'unexpected' as never,
        }),
      ],
    }).execute(
      {
        runId: 'unexpected-stop',
        systemPrompt: 'Preserve the provider response for audit.',
        history: [],
        currentTurn: currentTurn('开始'),
      },
      () => undefined,
    );
    expect(unexpected).toMatchObject({ status: 'completed' });
  });

  it('injects steering into the active Pi agent', async () => {
    const runtime = PiRuntimeAdapter.forTests({
      responses: ['处理中。', '已按新要求完成。'],
      tokensPerSecond: 1,
    });
    let steered = false;
    const execution = runtime.execute(
      {
        runId: 'session-steering',
        systemPrompt: 'Apply user steering after the current safe turn.',
        history: [],
        currentTurn: currentTurn('开始任务'),
      },
      (event) => {
        if (event.type === 'content.delta' && !steered) {
          steered = true;
          runtime.steer({ role: 'user', content: '增加成本分析', timestamp: Date.now() });
        }
      },
    );
    const result = await execution;
    expect(result.status).toBe('completed');
    expect(result.messages.at(-1)).toMatchObject({ content: '已按新要求完成。' });
  });

  it('uses the Pi beforeToolCall hook to block execution', async () => {
    let executions = 0;
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([fauxToolCall('blocked_tool', {}, { id: 'blocked-call' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxText('已处理阻断结果。')]),
      ],
    });
    const toolResults: RuntimeEvent[] = [];
    const result = await runtime.execute(
      {
        runId: 'run-hook',
        systemPrompt: 'Respect tool policy hooks.',
        history: [],
        currentTurn: currentTurn('尝试工具'),
        tools: [
          {
            name: 'blocked_tool',
            label: 'Blocked Tool',
            description: 'Must be blocked by policy',
            parameters: Type.Object({}, { additionalProperties: false }),
            execute: () => {
              executions += 1;
              return Promise.resolve({ unsafe: true });
            },
          },
        ],
        beforeToolCall: ({ toolCallId }) => ({
          block: toolCallId === 'blocked-call',
          reason: 'Policy denied this call',
        }),
      },
      (event) => {
        if (event.type === 'tool.completed') toolResults.push(event);
      },
    );

    expect(result.status).toBe('completed');
    expect(executions).toBe(0);
    expect(toolResults[0]).toMatchObject({
      type: 'tool.completed',
      result: { content: 'Policy denied this call', isError: true },
    });
  });

  it('uses the Pi afterToolCall hook to sanitize an executed result', async () => {
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([fauxToolCall('allowed_tool', {}, { id: 'allowed-call' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxText('已读取脱敏结果。')]),
      ],
    });
    const toolResults: RuntimeEvent[] = [];
    const result = await runtime.execute(
      {
        runId: 'run-after-hook',
        systemPrompt: 'Use sanitized tool results.',
        history: [],
        currentTurn: currentTurn('执行工具'),
        tools: [
          {
            name: 'allowed_tool',
            label: 'Allowed Tool',
            description: 'Returns private details before sanitization',
            parameters: Type.Object({}, { additionalProperties: false }),
            execute: () => Promise.resolve({ private: 'secret' }),
          },
        ],
        afterToolCall: ({ result: toolResult }) => ({
          content: `sanitized:${toolResult.content}`,
          details: { sanitized: true },
        }),
      },
      (event) => {
        if (event.type === 'tool.completed') toolResults.push(event);
      },
    );

    expect(result.status).toBe('completed');
    const completed = toolResults.find((event) => event.type === 'tool.completed');
    expect(completed?.type === 'tool.completed' ? completed.result.content : undefined).toContain(
      'sanitized:',
    );
    expect(completed?.type === 'tool.completed' ? completed.result.details : undefined).toEqual({
      sanitized: true,
    });
  });

  it('blocks domain tools beyond the request budget while preserving completion tools', async () => {
    let domainExecutions = 0;
    let completed = false;
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([fauxToolCall('domain_tool', {}, { id: 'domain-1' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('domain_tool', {}, { id: 'domain-2' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('task_complete', {}, { id: 'complete-1' })], {
          stopReason: 'toolUse',
        }),
      ],
    });
    const result = await runtime.execute(
      {
        runId: 'run-tool-budget',
        systemPrompt: 'Respect the domain tool budget and complete through task_complete.',
        history: [],
        currentTurn: currentTurn('执行受限任务'),
        maxToolCalls: 1,
        tools: [
          {
            name: 'domain_tool',
            label: 'Domain Tool',
            description: 'A budgeted domain tool',
            parameters: Type.Object({}, { additionalProperties: false }),
            execute: () => {
              domainExecutions += 1;
              return Promise.resolve({ ok: true });
            },
          },
          {
            name: 'task_complete',
            label: 'Complete Task',
            description: 'The protocol completion tool',
            parameters: Type.Object({}, { additionalProperties: false }),
            terminateOnSuccess: true,
            execute: () => {
              completed = true;
              return Promise.resolve({ accepted: true });
            },
          },
        ],
      },
      () => undefined,
    );

    expect(result.status).toBe('completed');
    expect(domainExecutions).toBe(1);
    expect(completed).toBe(true);
  });

  it('does not terminate a parallel turn before the completion tool can follow a blocked batch', async () => {
    let domainExecutions = 0;
    let completed = false;
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall('domain_tool', { query: 'allowed' }, { id: 'parallel-1' }),
            fauxToolCall('domain_tool', { query: 'blocked-1' }, { id: 'parallel-2' }),
            fauxToolCall('domain_tool', { query: 'blocked-2' }, { id: 'parallel-3' }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxToolCall('task_complete', {}, { id: 'parallel-complete' })], {
          stopReason: 'toolUse',
        }),
      ],
    });
    const result = await runtime.execute(
      {
        runId: 'run-parallel-tool-budget',
        systemPrompt: 'Complete after the domain tool budget is exhausted.',
        history: [],
        currentTurn: currentTurn('执行并发受限任务'),
        maxToolCalls: 1,
        tools: [
          {
            name: 'domain_tool',
            label: 'Domain Tool',
            description: 'A budgeted domain tool',
            parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }),
            execute: () => {
              domainExecutions += 1;
              return Promise.resolve({ ok: true });
            },
          },
          {
            name: 'task_complete',
            label: 'Complete Task',
            description: 'The protocol completion tool',
            parameters: Type.Object({}, { additionalProperties: false }),
            terminateOnSuccess: true,
            execute: () => {
              completed = true;
              return Promise.resolve({ accepted: true });
            },
          },
        ],
      },
      () => undefined,
    );

    expect(result.status).toBe('completed');
    expect(domainExecutions).toBe(1);
    expect(completed).toBe(true);
  });

  it('ends a Pi loop after repeated invalid completion tool calls', async () => {
    let executions = 0;
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([fauxToolCall('task_complete', {}, { id: 'invalid-complete-1' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('task_complete', {}, { id: 'invalid-complete-2' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('task_complete', {}, { id: 'invalid-complete-3' })], {
          stopReason: 'toolUse',
        }),
      ],
    });
    const result = await runtime.execute(
      {
        runId: 'run-invalid-completion-budget',
        systemPrompt: 'Complete through task_complete.',
        history: [],
        currentTurn: currentTurn('完成任务'),
        maxFailedCompletionCalls: 2,
        tools: [
          {
            name: 'task_complete',
            label: 'Complete Task',
            description: 'Reject invalid completion payloads',
            parameters: Type.Object(
              { status: Type.Literal('succeeded') },
              { additionalProperties: false },
            ),
            terminateOnSuccess: true,
            execute: () => {
              executions += 1;
              return Promise.resolve({ accepted: true });
            },
          },
        ],
      },
      () => undefined,
    );

    expect(result.status).toBe('failed');
    expect(executions).toBe(0);
  });

  it('fails closed after repeated identical side-effecting tool calls', async () => {
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([fauxToolCall('publish', { articleId: 'a-1' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('publish', { articleId: 'a-1' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('publish', { articleId: 'a-1' })], {
          stopReason: 'toolUse',
        }),
      ],
    });
    const result = await runtime.execute(
      {
        runId: 'run-loop-guard',
        systemPrompt: 'Use publish only when authorized.',
        history: [],
        currentTurn: currentTurn('发布文章'),
        toolLoopGuard: { maxConsecutiveIdenticalCalls: 2 },
        tools: [
          {
            name: 'publish',
            label: 'Publish',
            description: 'Publish an approved article',
            parameters: Type.Object({ articleId: Type.String() }),
            execute: () => Promise.resolve({ accepted: true }),
          },
        ],
      },
      () => undefined,
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'protocol_error' },
    });
  });
});

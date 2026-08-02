import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import {
  createArkBackend,
  createOpenAICompatibleBackend,
  PiRuntimeAdapter,
  RUNTIME_CURRENT_TURN_VERSION,
  type RuntimeCurrentTurn,
  type RuntimeEvent,
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
    });

    expect(backend.model).toMatchObject({
      provider: 'agent-model',
      id: 'gpt-compatible',
      baseUrl: 'https://models.example/v1',
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
        continuation: true,
      },
      () => undefined,
    );

    expect(result.status).toBe('completed');
    expect(result.messages.at(-1)).toMatchObject({ content: '恢复后的最终回答。' });
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
});

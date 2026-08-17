import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  validateToolArguments,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';

import type { RuntimeEvent } from '../src/contracts.js';
import type { RuntimeCurrentTurn } from '../src/current-turn.js';
import { PiRuntimeAdapter } from '../src/pi-runtime-adapter.js';
import { createProviderToolSchemaCodec } from '../src/provider-tool-schema-codec.js';

const openAiStrict = {
  dialect: 'openai',
  acceptsStrictTools: true,
  enforcesStrictTools: true,
} as const;

describe('provider tool schema codec', () => {
  it('round-trips introduced nullable optionals through nested objects and arrays', () => {
    const schema = Type.Object(
      {
        status: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
        failure: Type.Optional(Type.String()),
        artifacts: Type.Array(
          Type.Object(
            {
              content: Type.Object(
                {
                  summary: Type.Optional(Type.String()),
                  confidence: Type.Optional(Type.Number()),
                  requiredNullable: Type.Union([Type.String(), Type.Null()]),
                  sources: Type.Array(
                    Type.Object(
                      {
                        evidenceId: Type.String(),
                        sourceUri: Type.Optional(Type.String()),
                      },
                      { additionalProperties: false },
                    ),
                  ),
                },
                { additionalProperties: false },
              ),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    );
    const codec = createProviderToolSchemaCodec(schema, openAiStrict, 'require');
    const wire = codec.wireSchema as {
      readonly required?: readonly string[];
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    const raw = {
      status: 'succeeded',
      failure: null,
      artifacts: [
        {
          content: {
            summary: null,
            confidence: null,
            requiredNullable: null,
            sources: [{ evidenceId: 'evidence-1', sourceUri: null }],
          },
        },
      ],
    };

    expect(wire.required).toContain('failure');
    expect(codec.prepareArguments(raw)).toEqual(raw);
    expect(
      codec.prepareArguments({
        status: 'succeeded',
        artifacts: [
          {
            content: {
              requiredNullable: null,
              sources: [{ evidenceId: 'evidence-1' }],
            },
          },
        ],
      }),
    ).toEqual(raw);
    expect(codec.decodeArguments(raw)).toEqual({
      status: 'succeeded',
      artifacts: [
        {
          content: {
            requiredNullable: null,
            sources: [{ evidenceId: 'evidence-1' }],
          },
        },
      ],
    });
    expect(raw).toHaveProperty('failure', null);
    expect(codec.degradations).toContainEqual(
      expect.objectContaining({
        code: 'normalized_nullable',
        path: '$/properties/failure',
      }),
    );
  });

  it('requires the provider null placeholder while preserving host optionality', () => {
    const schema = Type.Object(
      {
        query: Type.String(),
        limit: Type.Optional(Type.Integer()),
      },
      { additionalProperties: false },
    );
    const codec = createProviderToolSchemaCodec(schema, openAiStrict, 'require');

    expect(codec.prepareArguments({ query: 'Kafka' })).toEqual({ query: 'Kafka', limit: null });
    expect(codec.decodeArguments({ query: 'Kafka', limit: null })).toEqual({ query: 'Kafka' });
  });

  it('keeps introduced null placeholders intact through the pinned Pi validator', () => {
    const schema = Type.Object(
      {
        query: Type.String(),
        limit: Type.Optional(Type.Integer()),
      },
      { additionalProperties: false },
    );
    const codec = createProviderToolSchemaCodec(schema, openAiStrict, 'require');
    const prepared = codec.prepareArguments({ query: 'Kafka' });
    const validated: unknown = validateToolArguments(
      { name: 'lookup', description: 'Lookup records', parameters: codec.wireSchema },
      { type: 'toolCall', id: 'provider-call', name: 'lookup', arguments: prepared },
    );

    expect(validated).toEqual({ query: 'Kafka', limit: null });
    expect(codec.decodeArguments(validated)).toEqual({ query: 'Kafka' });
    const explicit: unknown = validateToolArguments(
      { name: 'lookup', description: 'Lookup records', parameters: codec.wireSchema },
      {
        type: 'toolCall',
        id: 'provider-call-explicit',
        name: 'lookup',
        arguments: codec.prepareArguments({ query: 'Kafka', limit: 3 }),
      },
    );
    expect(codec.decodeArguments(explicit)).toEqual({ query: 'Kafka', limit: 3 });
  });

  it('rejects coercible raw values before Pi can convert them', () => {
    const schema = Type.Object({ count: Type.Integer() }, { additionalProperties: false });
    const codec = createProviderToolSchemaCodec(schema, openAiStrict, 'require');

    expect(() => codec.prepareArguments({ count: '3' })).toThrow(/host schema/u);
  });

  it('reapplies host constraints removed from the provider wire schema', () => {
    const schema = Type.Object(
      { confidence: Type.Number({ minimum: 0, maximum: 1 }) },
      { additionalProperties: false },
    );
    const codec = createProviderToolSchemaCodec(schema, openAiStrict, 'require');

    expect(() => codec.prepareArguments({ confidence: 2 })).toThrow(/host schema/u);
    expect(() => codec.decodeArguments({ confidence: 2 })).toThrow(/host schema/u);
  });

  it('uses the explicit capability instead of inferring dialect from a provider name', () => {
    const schema = Type.Object({ failure: Type.Optional(Type.String()) });
    const generic = createProviderToolSchemaCodec(
      schema,
      { dialect: 'generic', acceptsStrictTools: true, enforcesStrictTools: true },
      'require',
    );
    const unsupported = createProviderToolSchemaCodec(
      schema,
      { dialect: 'openai', acceptsStrictTools: false, enforcesStrictTools: false },
      'prefer',
    );

    expect(() => generic.prepareArguments({})).not.toThrow();
    expect(() => unsupported.prepareArguments({})).not.toThrow();
    expect(generic.degradations).not.toContainEqual(
      expect.objectContaining({ code: 'normalized_nullable' }),
    );
    expect(unsupported.degradations).not.toContainEqual(
      expect.objectContaining({ code: 'normalized_nullable' }),
    );
    expect(() =>
      createProviderToolSchemaCodec(
        schema,
        { dialect: 'openai', acceptsStrictTools: true, enforcesStrictTools: false },
        'require',
      ),
    ).toThrow(/does not enforce/u);
  });

  it('uses strict wire adaptation with host validation when enforcement is best-effort', () => {
    const schema = Type.Object(
      {
        query: Type.String(),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      },
      { additionalProperties: false },
    );
    const codec = createProviderToolSchemaCodec(
      schema,
      { dialect: 'openai', acceptsStrictTools: true, enforcesStrictTools: false },
      'prefer',
    );

    expect(codec.prepareArguments({ query: 'AgentPress' })).toEqual({
      query: 'AgentPress',
      limit: null,
    });
    expect(codec.decodeArguments({ query: 'AgentPress', limit: null })).toEqual({
      query: 'AgentPress',
    });
    expect(() => codec.prepareArguments({ query: 'AgentPress', limit: 9 })).toThrow(/host schema/u);
  });

  it('runs the raw precheck through the Pi prepareArguments hook', async () => {
    let executions = 0;
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([fauxToolCall('count_items', { count: '3' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxText('Handled invalid input.')]),
      ],
    });
    const events: RuntimeEvent[] = [];
    const result = await runtime.execute(
      {
        runId: 'raw-provider-arguments',
        systemPrompt: 'Call the tool.',
        history: [],
        currentTurn: currentTurn('count'),
        tools: [
          {
            name: 'count_items',
            label: 'Count items',
            description: 'Count items',
            parameters: Type.Object({ count: Type.Integer() }, { additionalProperties: false }),
            constrainedSampling: { type: 'json_schema', strict: 'require' },
            execute: () => {
              executions += 1;
              return Promise.resolve({ ok: true });
            },
          },
        ],
      },
      (event) => {
        events.push(event);
      },
    );

    expect(result.status).toBe('completed');
    expect(executions).toBe(0);
    const completed = events.find((event) => event.type === 'tool.completed');
    expect(completed?.type).toBe('tool.completed');
    if (completed?.type === 'tool.completed') expect(completed.result.isError).toBe(true);
  });

  it('counts and terminates repeated tool preflight failures without executing the tool', async () => {
    let executions = 0;
    const failures: { readonly arguments: unknown; readonly failure: string }[] = [];
    const runtime = PiRuntimeAdapter.forTests({
      responses: [
        fauxAssistantMessage([fauxToolCall('count_items', { count: '3' }, { id: 'invalid-1' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('count_items', { count: '4' }, { id: 'invalid-2' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxText('This response must not be reached.')]),
      ],
    });
    const events: RuntimeEvent[] = [];
    const result = await runtime.execute(
      {
        runId: 'bounded-provider-arguments',
        systemPrompt: 'Call the tool with a valid integer.',
        history: [],
        currentTurn: currentTurn('count'),
        maxFailedToolPreflightCalls: 2,
        tools: [
          {
            name: 'count_items',
            label: 'Count items',
            description: 'Count items',
            parameters: Type.Object({ count: Type.Integer() }, { additionalProperties: false }),
            constrainedSampling: { type: 'json_schema', strict: 'require' },
            onPreflightFailure: (arguments_, { failure }) => {
              failures.push({ arguments: arguments_, failure });
              return Promise.resolve();
            },
            execute: () => {
              executions += 1;
              return Promise.resolve({ ok: true });
            },
          },
        ],
      },
      (event) => {
        events.push(event);
      },
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'protocol_error',
        message: 'Tool preflight failed validation 2 times',
        retryable: false,
      },
    });
    expect(executions).toBe(0);
    expect(failures).toHaveLength(2);
    expect(failures.map(({ arguments: value }) => value)).toEqual([{ count: '3' }, { count: '4' }]);
    expect(events.filter(({ type }) => type === 'tool.completed')).toHaveLength(2);
  });
});

function currentTurn(request: string): RuntimeCurrentTurn {
  return {
    type: 'agentpress_current_turn',
    version: 1,
    source: 'user',
    request,
    actionEnvelope: { version: 1, source: 'free_text', grantedCapabilities: [] },
    timestamp: 1,
  };
}

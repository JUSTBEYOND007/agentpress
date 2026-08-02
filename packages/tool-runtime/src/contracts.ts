import type { Static, TSchema } from '@sinclair/typebox';

export type ToolRisk = 'read_only' | 'draft_write' | 'external_write' | 'destructive';
export type ToolIdempotency = 'none' | 'provider_key';

export type ToolExecutionContext = {
  readonly runId: string;
  readonly taskId?: string;
  readonly toolCallId: string;
  readonly idempotencyKey?: string;
  readonly signal: AbortSignal;
};

export type ToolDefinition<TInput extends TSchema = TSchema, TOutput extends TSchema = TSchema> = {
  readonly toolId: string;
  readonly version: string;
  readonly owner: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  readonly risk: ToolRisk;
  readonly sideEffect: string;
  readonly idempotency: ToolIdempotency;
  readonly timeoutMs: number;
  readonly estimateCost: (input: Static<TInput>) => Readonly<Record<string, number>>;
  readonly execute: (
    input: Static<TInput>,
    context: ToolExecutionContext,
  ) => Promise<Static<TOutput>>;
};

export type RegisteredTool = Omit<ToolDefinition, 'estimateCost' | 'execute'> & {
  readonly estimateCost: (input: unknown) => Readonly<Record<string, number>>;
  readonly execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
};

export type CapabilityPolicy = {
  readonly platform: ReadonlySet<string>;
  readonly workspace: ReadonlySet<string>;
  readonly agent: ReadonlySet<string>;
  readonly skill: ReadonlySet<string>;
  readonly task: ReadonlySet<string>;
};

export type SelectedTool = {
  readonly toolId: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly risk: ToolRisk;
};

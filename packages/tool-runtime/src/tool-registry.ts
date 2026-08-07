import { validateSchemaResult } from '@agentpress/schema-runtime';
import type { TSchema } from '@sinclair/typebox';

import type {
  CapabilityPolicy,
  RegisteredTool,
  SelectedTool,
  ToolDefinition,
  ToolExecutionContext,
} from './contracts.js';
import { ToolRuntimeError } from './tool-errors.js';

export class ToolRegistry {
  private readonly definitions = new Map<string, RegisteredTool>();

  public register<TInput extends TSchema, TOutput extends TSchema>(
    definition: ToolDefinition<TInput, TOutput>,
  ): void {
    validateDefinition(definition);
    const key = toolKey(definition.toolId, definition.version);
    if (this.definitions.has(key)) {
      throw new ToolRuntimeError('duplicate_tool', `Tool ${key} is already registered`);
    }
    this.definitions.set(key, {
      ...definition,
      estimateCost: (input) => definition.estimateCost(input),
      execute: (input, context) => definition.execute(input, context),
    });
  }

  public get(toolId: string, version: string): RegisteredTool {
    const definition = this.definitions.get(toolKey(toolId, version));
    if (!definition) {
      throw new ToolRuntimeError('tool_not_found', `Tool ${toolId}@${version} is not registered`);
    }
    return definition;
  }

  public list(): readonly RegisteredTool[] {
    return [...this.definitions.values()];
  }

  public validateInput(definition: RegisteredTool, input: unknown): asserts input is object {
    validateSchema(definition.inputSchema, input, 'invalid_input', definition);
  }

  public validateOutput(definition: RegisteredTool, output: unknown): void {
    validateSchema(definition.outputSchema, output, 'invalid_output', definition);
  }

  public async execute(
    definition: RegisteredTool,
    input: Readonly<Record<string, unknown>>,
    context: Omit<ToolExecutionContext, 'signal'> & { readonly signal?: AbortSignal },
  ): Promise<unknown> {
    this.validateInput(definition, input);
    const timeout = AbortSignal.timeout(definition.timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    try {
      const output: unknown = await definition.execute(input, { ...context, signal });
      this.validateOutput(definition, output);
      return output;
    } catch (error) {
      if (timeout.aborted && !context.signal?.aborted) {
        throw new ToolRuntimeError('tool_timeout', `Tool ${definition.toolId} timed out`, {
          timeoutMs: definition.timeoutMs,
        });
      }
      throw error;
    }
  }
}

export class CapabilityCatalog {
  public constructor(private readonly registry: ToolRegistry) {}

  public select(query: string, policy: CapabilityPolicy, limit = 8): readonly SelectedTool[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
      throw new RangeError('Capability Catalog limit must be between 1 and 16');
    }
    const allowed = intersectPolicy(policy);
    const terms = tokenize(query);
    return this.registry
      .list()
      .filter((tool) => tool.capabilities.every((capability) => allowed.has(capability)))
      .map((tool) => ({ tool, score: scoreTool(tool, terms) }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          toolKey(left.tool.toolId, left.tool.version).localeCompare(
            toolKey(right.tool.toolId, right.tool.version),
          ),
      )
      .slice(0, limit)
      .map(({ tool }) => ({
        toolId: tool.toolId,
        version: tool.version,
        description: tool.description,
        guidance: tool.guidance ?? [],
        capabilities: tool.capabilities,
        risk: tool.risk,
      }));
  }
}

function validateDefinition(
  definition: Pick<
    ToolDefinition,
    'toolId' | 'version' | 'capabilities' | 'timeoutMs' | 'guidance' | 'evidence'
  >,
): void {
  if (!definition.toolId || !definition.version || definition.capabilities.length === 0) {
    throw new TypeError('Tool identity, version, and capabilities are required');
  }
  if (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1) {
    throw new TypeError('Tool timeout must be a positive integer');
  }
  const guidance = definition.guidance ?? [];
  const ids = new Set<string>();
  for (const item of guidance) {
    if (!item.id.trim() || ids.has(item.id) || !item.text.trim()) {
      throw new TypeError('Tool guidance requires unique IDs and non-empty text');
    }
    ids.add(item.id);
  }
  if (guidance.length > 16) throw new TypeError('Tool guidance is limited to 16 entries');
  if (definition.evidence) validateEvidenceProvenance(definition.evidence);
}

function validateEvidenceProvenance(evidence: NonNullable<ToolDefinition['evidence']>): void {
  if (
    !evidence.providerRevision.trim() ||
    evidence.providerRevision !== evidence.providerRevision.trim() ||
    evidence.providerRevision.length > 160
  ) {
    throw new TypeError('Tool evidence provider revision must be 1-160 trimmed characters');
  }
}

/** Renders deterministic, descriptive guidance for the model context. */
export function composeToolGuidance(tools: readonly SelectedTool[]): string {
  const lines = tools.flatMap((tool) =>
    tool.guidance.map(
      (item) => `- ${tool.toolId}@${tool.version} (${item.id}): ${item.text.trim()}`,
    ),
  );
  return lines.length === 0 ? '' : ['Tool-specific guidance:', ...lines].join('\n');
}

function validateSchema(
  schema: TSchema,
  value: unknown,
  code: 'invalid_input' | 'invalid_output',
  definition: RegisteredTool,
): void {
  const validation = validateSchemaResult(schema, value, 'strict');
  if (validation.valid) return;
  throw new ToolRuntimeError(code, `${definition.toolId} ${code.replace('_', ' ')}`, {
    errors: validation.failures,
  });
}

function intersectPolicy(policy: CapabilityPolicy): ReadonlySet<string> {
  const layers = [policy.workspace, policy.agent, policy.skill, policy.task];
  return new Set(
    [...policy.platform].filter((capability) => layers.every((set) => set.has(capability))),
  );
}

function tokenize(value: string): ReadonlySet<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}_.-]+/u)
      .filter(Boolean),
  );
}

function scoreTool(tool: RegisteredTool, terms: ReadonlySet<string>): number {
  const haystack = tokenize(`${tool.toolId} ${tool.description} ${tool.capabilities.join(' ')}`);
  return [...terms].reduce(
    (score, term) =>
      score +
      (haystack.has(term)
        ? 2
        : [...haystack].some((candidate) => candidate.includes(term))
          ? 1
          : 0),
    0,
  );
}

function toolKey(toolId: string, version: string): string {
  return `${toolId}@${version}`;
}

// Behavior adapted from Oh My Pi v17.1.8, commit f446b8a (MIT).
// Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Boluk.
import { TypeGuard, type TSchema } from '@sinclair/typebox';

export const SPECIALIST_TASK_MAX_DEPTH = 2;
export const SPECIALIST_TASK_MAX_TIMEOUT_MS = 10 * 60_000;
export const SPECIALIST_TASK_MAX_ATTEMPTS = 5;

export type SpecialistRole = 'researcher' | 'writer' | 'editor' | 'fact_checker' | 'illustrator';

export type SpecialistTaskRequest = {
  readonly taskId: string;
  readonly runId: string;
  readonly parentTaskId?: string;
  readonly depth: number;
  readonly owner: SpecialistRole;
  readonly objective: string;
  readonly contextPackId?: string;
  readonly capabilities: readonly string[];
  readonly outputSchema: TSchema;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly detached: boolean;
  /** Host-owned parent identity used to prevent same-role recursive spawning. */
  readonly parentOwner?: 'main' | SpecialistRole;
  /** Optional allowlist for the parent Skill/Agent spawn policy. */
  readonly allowedOwners?: readonly SpecialistRole[];
};

export type SpecialistOutputSchemaMode = 'strict' | 'permissive';
export type SpecialistOutputSchemaSource = 'caller' | 'agent' | 'session' | 'none';

export type SpecialistOutputSchemaResolution = {
  readonly schema: unknown;
  readonly source: SpecialistOutputSchemaSource;
  readonly mode: SpecialistOutputSchemaMode;
  readonly callerOverridesAgent: boolean;
};

/** Mirrors the pinned Oh My Pi policy while keeping TypeBox as the host contract. */
export function resolveSpecialistOutputSchema(input: {
  readonly callerOutputSchema?: unknown;
  readonly agentOutputSchema?: unknown;
  readonly sessionOutputSchema?: unknown;
  readonly schemaMode?: SpecialistOutputSchemaMode;
  readonly sessionSchemaMode?: SpecialistOutputSchemaMode;
}): SpecialistOutputSchemaResolution {
  const mode = input.schemaMode ?? input.sessionSchemaMode ?? 'permissive';
  if (Object.hasOwn(input, 'callerOutputSchema')) {
    return {
      schema: input.callerOutputSchema,
      source: 'caller',
      mode,
      callerOverridesAgent: true,
    };
  }
  if (input.agentOutputSchema !== undefined) {
    return {
      schema: input.agentOutputSchema,
      source: 'agent',
      mode,
      callerOverridesAgent: false,
    };
  }
  if (input.sessionOutputSchema !== undefined) {
    return {
      schema: input.sessionOutputSchema,
      source: 'session',
      mode,
      callerOverridesAgent: false,
    };
  }
  return { schema: undefined, source: 'none', mode, callerOverridesAgent: false };
}

export function assertSpecialistOutputSchema(
  resolution: SpecialistOutputSchemaResolution,
): asserts resolution is SpecialistOutputSchemaResolution & { readonly schema: TSchema } {
  if (resolution.source === 'none') return;
  if (resolution.source !== 'caller' && resolution.mode !== 'strict') return;
  if (!TypeGuard.IsSchema(resolution.schema)) {
    const scope = resolution.source === 'caller' ? 'caller' : 'strict effective';
    throw new TypeError(`Invalid ${scope} Specialist output schema`);
  }
}

export function createSpecialistTaskRequest(input: SpecialistTaskRequest): SpecialistTaskRequest {
  validateSpecialistTaskRequest(input);
  return {
    ...input,
    capabilities: [...new Set(input.capabilities)].sort(),
    ...(input.allowedOwners ? { allowedOwners: [...new Set(input.allowedOwners)].sort() } : {}),
  };
}

export function validateSpecialistTaskRequest(input: SpecialistTaskRequest): void {
  if (!input.taskId || !input.runId || !input.objective.trim()) {
    throw new TypeError('Specialist Task identity and objective are required');
  }
  if (!specialistRoles.includes(input.owner)) {
    throw new TypeError(`Unknown Specialist owner ${input.owner}`);
  }
  if (
    input.parentOwner &&
    input.parentOwner !== 'main' &&
    !specialistRoles.includes(input.parentOwner)
  ) {
    throw new TypeError(`Unknown Specialist parent owner ${input.parentOwner}`);
  }
  if (input.allowedOwners !== undefined && !Array.isArray(input.allowedOwners)) {
    throw new TypeError('Specialist Task allowedOwners must be an array');
  }
  if (
    !Number.isSafeInteger(input.depth) ||
    input.depth < 0 ||
    input.depth > SPECIALIST_TASK_MAX_DEPTH
  ) {
    throw new RangeError(
      `Specialist Task depth must be between 0 and ${String(SPECIALIST_TASK_MAX_DEPTH)}`,
    );
  }
  if (input.depth === 0 && input.parentTaskId) {
    throw new Error('Root Specialist Task cannot have a parent task');
  }
  if (input.depth > 0 && (!input.parentTaskId || input.parentTaskId === input.taskId)) {
    throw new Error('Nested Specialist Task requires a distinct parent task');
  }
  if (input.depth > 0 && !input.parentOwner) {
    throw new Error('Nested Specialist Task requires a parent owner');
  }
  if (input.parentOwner && input.parentOwner === input.owner) {
    throw new Error('Specialist Task cannot recursively spawn the same owner');
  }
  if (
    input.allowedOwners &&
    (input.allowedOwners.length > 8 ||
      input.allowedOwners.some((owner) => !isSpecialistRole(owner)) ||
      !input.allowedOwners.includes(input.owner))
  ) {
    throw new Error('Specialist Task owner is blocked by the parent spawn policy');
  }
  if (
    input.capabilities.length > 16 ||
    input.capabilities.some((capability) => !capability.trim())
  ) {
    throw new RangeError('Specialist Task capabilities exceed the bounded policy');
  }
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > SPECIALIST_TASK_MAX_TIMEOUT_MS
  ) {
    throw new RangeError('Specialist Task timeout is outside the bounded policy');
  }
  if (
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > SPECIALIST_TASK_MAX_ATTEMPTS
  ) {
    throw new RangeError('Specialist Task attempt budget is outside the bounded policy');
  }
  if (typeof input.detached !== 'boolean')
    throw new TypeError('Specialist Task detached must be boolean');
}

export function parseSpecialistTaskRequest(value: unknown): SpecialistTaskRequest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.taskId !== 'string' ||
    typeof raw.runId !== 'string' ||
    typeof raw.depth !== 'number' ||
    typeof raw.owner !== 'string' ||
    typeof raw.objective !== 'string' ||
    !Array.isArray(raw.capabilities) ||
    typeof raw.timeoutMs !== 'number' ||
    typeof raw.maxAttempts !== 'number' ||
    typeof raw.detached !== 'boolean'
  ) {
    throw new TypeError('Persisted Specialist Task request is malformed');
  }
  const request = raw as unknown as SpecialistTaskRequest;
  validateSpecialistTaskRequest(request);
  return request;
}

export function specialistConcurrencyLimit(requested = 3, providerLimit = 8): number {
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 8) {
    throw new RangeError('Specialist concurrency must be between 1 and 8');
  }
  if (!Number.isSafeInteger(providerLimit) || providerLimit < 1 || providerLimit > 8) {
    throw new RangeError('Provider concurrency must be between 1 and 8');
  }
  return Math.min(requested, providerLimit);
}

const specialistRoles: readonly SpecialistRole[] = [
  'researcher',
  'writer',
  'editor',
  'fact_checker',
  'illustrator',
];

function isSpecialistRole(value: unknown): value is SpecialistRole {
  return typeof value === 'string' && specialistRoles.includes(value as SpecialistRole);
}

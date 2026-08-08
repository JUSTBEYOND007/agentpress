import { ToolExecutionError, ToolRuntimeError } from '@agentpress/tool-runtime';

export type PublicToolFailure = {
  readonly code:
    | 'invalid_input'
    | 'invalid_output'
    | 'tool_timeout'
    | 'tool_unavailable'
    | 'provider_failed'
    | 'outcome_unknown';
  readonly messageKey:
    | 'tool.failure.invalid_input'
    | 'tool.failure.invalid_output'
    | 'tool.failure.timeout'
    | 'tool.failure.unavailable'
    | 'tool.failure.provider'
    | 'tool.failure.outcome_unknown';
  readonly retryable: boolean;
};

export type ProtectedToolFailure = PublicToolFailure & {
  readonly message: string;
  readonly errorType: string;
  readonly visibility: 'protected';
};

export function projectToolFailure(
  error: unknown,
  sideEffectRisk: boolean,
): {
  readonly status: 'failed' | 'outcome_unknown';
  readonly publicFailure: PublicToolFailure;
  readonly diagnosticFailure: ProtectedToolFailure;
} {
  const publicFailure = classifyPublicFailure(error, sideEffectRisk);
  return {
    status: publicFailure.code === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
    publicFailure,
    diagnosticFailure: {
      ...publicFailure,
      message: diagnosticMessage(error),
      errorType: error instanceof Error ? error.name : 'NonErrorThrown',
      visibility: 'protected',
    },
  };
}

function classifyPublicFailure(error: unknown, sideEffectRisk: boolean): PublicToolFailure {
  if (error instanceof ToolRuntimeError) {
    if (error.code === 'invalid_input') {
      return failure('invalid_input', 'tool.failure.invalid_input', false);
    }
    if (error.code === 'invalid_output') {
      return failure('invalid_output', 'tool.failure.invalid_output', true);
    }
    if (error.code === 'tool_timeout') {
      return failure('tool_timeout', 'tool.failure.timeout', true);
    }
    return failure('tool_unavailable', 'tool.failure.unavailable', true);
  }
  if (error instanceof ToolExecutionError && error.outcome === 'unknown') {
    return failure('outcome_unknown', 'tool.failure.outcome_unknown', false);
  }
  if (sideEffectRisk) {
    return failure('outcome_unknown', 'tool.failure.outcome_unknown', false);
  }
  return failure('provider_failed', 'tool.failure.provider', true);
}

function failure(
  code: PublicToolFailure['code'],
  messageKey: PublicToolFailure['messageKey'],
  retryable: boolean,
): PublicToolFailure {
  return { code, messageKey, retryable };
}

function diagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown tool error';
  return message.slice(0, 4_000);
}

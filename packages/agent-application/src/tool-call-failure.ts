import {
  ToolExecutionError,
  ToolRuntimeError,
  type ToolExecutionOutcomeReason,
} from '@agentpress/tool-runtime';

export type PublicToolFailure = {
  readonly code:
    | 'invalid_input'
    | 'invalid_output'
    | 'tool_timeout'
    | 'tool_rate_limited'
    | 'tool_authentication_failed'
    | 'tool_unavailable'
    | 'provider_failed'
    | 'outcome_unknown';
  readonly messageKey:
    | 'tool.failure.invalid_input'
    | 'tool.failure.invalid_output'
    | 'tool.failure.timeout'
    | 'tool.failure.rate_limited'
    | 'tool.failure.authentication'
    | 'tool.failure.unavailable'
    | 'tool.failure.provider'
    | 'tool.failure.outcome_unknown';
  readonly retryable: boolean;
  readonly outcomeReason?: ToolExecutionOutcomeReason;
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
    if (error.code === 'tool_rate_limited') {
      return failure('tool_rate_limited', 'tool.failure.rate_limited', true);
    }
    if (error.code === 'tool_authentication_failed') {
      return failure('tool_authentication_failed', 'tool.failure.authentication', false);
    }
    return failure('tool_unavailable', 'tool.failure.unavailable', true);
  }
  if (error instanceof ToolExecutionError) {
    if (error.outcome === 'unknown') {
      return failure('outcome_unknown', 'tool.failure.outcome_unknown', false, error.outcomeReason);
    }
    return failure('provider_failed', 'tool.failure.provider', true, error.outcomeReason);
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
  outcomeReason?: ToolExecutionOutcomeReason,
): PublicToolFailure {
  return { code, messageKey, retryable, ...(outcomeReason ? { outcomeReason } : {}) };
}

function diagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown tool error';
  return message.slice(0, 4_000);
}

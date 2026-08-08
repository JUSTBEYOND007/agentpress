import type { RunPart } from './agent-runtime-contracts';

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
  readonly outcomeReason?:
    | 'connection_unavailable_before_dispatch'
    | 'initialization_failed_before_dispatch'
    | 'connection_lost_after_dispatch'
    | 'run_cancelled_after_dispatch'
    | 'worker_lease_lost_after_dispatch'
    | 'stale_client_result'
    | 'timeout_after_dispatch';
};

const contracts: Readonly<
  Record<
    PublicToolFailure['code'],
    {
      readonly messageKey: PublicToolFailure['messageKey'];
      readonly retryable: boolean;
      readonly message: string;
    }
  >
> = {
  invalid_input: {
    messageKey: 'tool.failure.invalid_input',
    retryable: false,
    message: '参数不符合要求，请重新提交。',
  },
  invalid_output: {
    messageKey: 'tool.failure.invalid_output',
    retryable: true,
    message: '工具返回结果未通过校验，请重试。',
  },
  tool_timeout: {
    messageKey: 'tool.failure.timeout',
    retryable: true,
    message: '工具响应超时，请稍后重试。',
  },
  tool_rate_limited: {
    messageKey: 'tool.failure.rate_limited',
    retryable: true,
    message: '请求过于频繁，请稍后重试。',
  },
  tool_authentication_failed: {
    messageKey: 'tool.failure.authentication',
    retryable: false,
    message: '工具凭据不可用，请联系管理员更新配置。',
  },
  tool_unavailable: {
    messageKey: 'tool.failure.unavailable',
    retryable: true,
    message: '工具暂时不可用，请稍后重试。',
  },
  provider_failed: {
    messageKey: 'tool.failure.provider',
    retryable: true,
    message: '工具执行未完成，请稍后重试。',
  },
  outcome_unknown: {
    messageKey: 'tool.failure.outcome_unknown',
    retryable: false,
    message: '工具结果暂时无法确认，请先核对。',
  },
};

export function projectPublicToolFailure(value: unknown): PublicToolFailure | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const code = stringValue(record.code);
  const messageKey = stringValue(record.messageKey);
  const retryable = typeof record.retryable === 'boolean' ? record.retryable : undefined;
  const rawOutcomeReason = stringValue(record.outcomeReason);
  const contract = code ? contracts[code as PublicToolFailure['code']] : undefined;
  if (!contract || messageKey !== contract.messageKey || retryable !== contract.retryable) {
    return undefined;
  }
  if (rawOutcomeReason && !isOutcomeReason(rawOutcomeReason)) return undefined;
  const outcomeReason = rawOutcomeReason as PublicToolFailure['outcomeReason'];
  if (outcomeReason && !isReasonCompatible(code, outcomeReason)) return undefined;
  return {
    code: code as PublicToolFailure['code'],
    messageKey: contract.messageKey,
    retryable,
    ...(outcomeReason ? { outcomeReason } : {}),
  };
}

function isReasonCompatible(
  code: string | undefined,
  reason: NonNullable<PublicToolFailure['outcomeReason']>,
): boolean {
  if (
    reason === 'connection_unavailable_before_dispatch' ||
    reason === 'initialization_failed_before_dispatch'
  ) {
    return code === 'provider_failed';
  }
  return code === 'outcome_unknown';
}

function isOutcomeReason(value: string): value is NonNullable<PublicToolFailure['outcomeReason']> {
  return (
    value === 'connection_unavailable_before_dispatch' ||
    value === 'initialization_failed_before_dispatch' ||
    value === 'connection_lost_after_dispatch' ||
    value === 'run_cancelled_after_dispatch' ||
    value === 'worker_lease_lost_after_dispatch' ||
    value === 'stale_client_result' ||
    value === 'timeout_after_dispatch'
  );
}

export function toolFailureSummary(part: RunPart): string | undefined {
  const failure = projectPublicToolFailure(part.payload.failure);
  if (!failure) return undefined;
  if (failure.outcomeReason === 'connection_unavailable_before_dispatch') {
    return '连接建立失败，工具尚未执行，可以重试。';
  }
  if (failure.outcomeReason === 'initialization_failed_before_dispatch') {
    return '工具初始化失败，尚未执行，可以重试。';
  }
  if (failure.outcomeReason === 'connection_lost_after_dispatch') {
    return '工具发出后连接中断，结果无法确认，请先核对。';
  }
  if (failure.outcomeReason === 'run_cancelled_after_dispatch') {
    return '取消发生在工具发出后，结果无法确认，请先核对。';
  }
  if (failure.outcomeReason === 'worker_lease_lost_after_dispatch') {
    return '工具发出后执行进程中断，结果无法确认，请先核对。';
  }
  if (failure.outcomeReason === 'stale_client_result') {
    return '旧连接返回了迟到结果，结果无法确认，请先核对。';
  }
  if (failure.outcomeReason === 'timeout_after_dispatch') {
    return '工具发出后执行超时，结果无法确认，请先核对。';
  }
  return contracts[failure.code].message;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

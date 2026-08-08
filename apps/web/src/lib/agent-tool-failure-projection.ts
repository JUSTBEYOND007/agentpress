import type { RunPart } from './agent-runtime-contracts';

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
  const contract = code ? contracts[code as PublicToolFailure['code']] : undefined;
  if (!contract || messageKey !== contract.messageKey || retryable !== contract.retryable) {
    return undefined;
  }
  return {
    code: code as PublicToolFailure['code'],
    messageKey: contract.messageKey,
    retryable,
  };
}

export function toolFailureSummary(part: RunPart): string | undefined {
  const failure = projectPublicToolFailure(part.payload.failure);
  return failure ? contracts[failure.code].message : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

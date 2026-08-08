import { describe, expect, it } from 'vitest';

import type { RunPart } from './agent-runtime-contracts';
import { projectPublicToolFailure, toolFailureSummary } from './agent-tool-failure-projection';

describe('public ToolCall failure projection', () => {
  it('localizes a typed public failure without accepting a diagnostic message', () => {
    const failure = {
      code: 'tool_timeout',
      messageKey: 'tool.failure.timeout',
      retryable: true,
      message: 'credential=secret',
      stack: '/private/runtime.ts:42',
    };
    expect(projectPublicToolFailure(failure)).toEqual({
      code: 'tool_timeout',
      messageKey: 'tool.failure.timeout',
      retryable: true,
    });
    expect(toolFailureSummary(activity(failure))).toBe('工具响应超时，请稍后重试。');
  });

  it('fails closed for legacy untyped failure payloads', () => {
    const legacy = { message: 'provider credential=secret', stack: '/private/runtime.ts:42' };
    expect(projectPublicToolFailure(legacy)).toBeUndefined();
    expect(toolFailureSummary(activity(legacy))).toBeUndefined();
    expect(
      projectPublicToolFailure({
        code: 'provider_failed',
        messageKey: 'tool.failure.timeout',
        retryable: true,
      }),
    ).toBeUndefined();
  });

  it('localizes rate limiting and rejects contract drift', () => {
    const failure = {
      code: 'tool_rate_limited',
      messageKey: 'tool.failure.rate_limited',
      retryable: true,
      message: 'provider credential=secret',
    };
    expect(projectPublicToolFailure(failure)).toEqual({
      code: 'tool_rate_limited',
      messageKey: 'tool.failure.rate_limited',
      retryable: true,
    });
    expect(toolFailureSummary(activity(failure))).toBe('请求过于频繁，请稍后重试。');
    expect(projectPublicToolFailure({ ...failure, retryable: false })).toBeUndefined();
    expect(
      projectPublicToolFailure({ ...failure, messageKey: 'tool.failure.provider' }),
    ).toBeUndefined();
  });

  it('localizes credential failure and rejects retryability drift', () => {
    const failure = {
      code: 'tool_authentication_failed',
      messageKey: 'tool.failure.authentication',
      retryable: false,
      message: 'authorization=secret',
    };
    expect(projectPublicToolFailure(failure)).toEqual({
      code: 'tool_authentication_failed',
      messageKey: 'tool.failure.authentication',
      retryable: false,
    });
    expect(toolFailureSummary(activity(failure))).toBe('工具凭据不可用，请联系管理员更新配置。');
    expect(projectPublicToolFailure({ ...failure, retryable: true })).toBeUndefined();
  });

  it.each([
    [
      'initialization_failed_before_dispatch',
      'provider_failed',
      'tool.failure.provider',
      true,
      '工具初始化失败，尚未执行，可以重试。',
    ],
    [
      'connection_unavailable_before_dispatch',
      'provider_failed',
      'tool.failure.provider',
      true,
      '连接建立失败，工具尚未执行，可以重试。',
    ],
    [
      'connection_lost_after_dispatch',
      'outcome_unknown',
      'tool.failure.outcome_unknown',
      false,
      '工具发出后连接中断，结果无法确认，请先核对。',
    ],
    [
      'stale_client_result',
      'outcome_unknown',
      'tool.failure.outcome_unknown',
      false,
      '旧连接返回了迟到结果，结果无法确认，请先核对。',
    ],
    [
      'run_cancelled_after_dispatch',
      'outcome_unknown',
      'tool.failure.outcome_unknown',
      false,
      '取消发生在工具发出后，结果无法确认，请先核对。',
    ],
    [
      'timeout_after_dispatch',
      'outcome_unknown',
      'tool.failure.outcome_unknown',
      false,
      '工具发出后执行超时，结果无法确认，请先核对。',
    ],
  ] as const)(
    'projects the %s transport reason without diagnostic fields',
    (outcomeReason, code, messageKey, retryable, summary) => {
      const failure = {
        code,
        messageKey,
        retryable,
        outcomeReason,
        message: 'credential=secret',
      };
      expect(projectPublicToolFailure(failure)).toEqual({
        code,
        messageKey,
        retryable,
        outcomeReason,
      });
      expect(toolFailureSummary(activity(failure))).toBe(summary);
    },
  );

  it('fails closed for unknown or incompatible transport reasons', () => {
    expect(
      projectPublicToolFailure({
        code: 'outcome_unknown',
        messageKey: 'tool.failure.outcome_unknown',
        retryable: false,
        outcomeReason: 'made_up_reason',
      }),
    ).toBeUndefined();
    expect(
      projectPublicToolFailure({
        code: 'tool_timeout',
        messageKey: 'tool.failure.timeout',
        retryable: true,
        outcomeReason: 'connection_lost_after_dispatch',
      }),
    ).toBeUndefined();
    expect(
      projectPublicToolFailure({
        code: 'provider_failed',
        messageKey: 'tool.failure.provider',
        retryable: true,
        outcomeReason: 'stale_client_result',
      }),
    ).toBeUndefined();
  });
});

function activity(failure: unknown): RunPart {
  return {
    id: 'tool-failure',
    runId: 'run-1',
    sequence: 1,
    type: 'activity',
    status: 'tool.failed',
    payload: { failure },
  };
}

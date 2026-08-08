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

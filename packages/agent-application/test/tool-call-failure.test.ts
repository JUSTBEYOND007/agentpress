import { ToolExecutionError, ToolRuntimeError } from '@agentpress/tool-runtime';
import { describe, expect, it } from 'vitest';

import { projectToolFailure } from '../src/tool-call-failure.js';

describe('Tool Call failure projection', () => {
  it('maps typed runtime failures without exposing diagnostic messages', () => {
    const projected = projectToolFailure(
      new ToolRuntimeError('invalid_output', 'provider token secret', { response: 'private' }),
      false,
    );
    expect(projected).toEqual({
      status: 'failed',
      publicFailure: {
        code: 'invalid_output',
        messageKey: 'tool.failure.invalid_output',
        retryable: true,
      },
      diagnosticFailure: {
        code: 'invalid_output',
        messageKey: 'tool.failure.invalid_output',
        retryable: true,
        message: 'provider token secret',
        errorType: 'ToolRuntimeError',
        visibility: 'protected',
      },
    });
    expect(JSON.stringify(projected.publicFailure)).not.toContain('secret');
  });

  it('keeps unknown outcome distinct and non-retryable', () => {
    expect(
      projectToolFailure(
        new ToolExecutionError('connection secret', 'unknown', 'stale_client_result'),
        false,
      ),
    ).toMatchObject({
      status: 'outcome_unknown',
      publicFailure: {
        code: 'outcome_unknown',
        messageKey: 'tool.failure.outcome_unknown',
        retryable: false,
        outcomeReason: 'stale_client_result',
      },
    });
  });

  it('keeps a proven pre-dispatch failure retryable even for a side-effect risk', () => {
    expect(
      projectToolFailure(
        new ToolExecutionError(
          'connection failed before dispatch',
          'known_failed',
          'connection_unavailable_before_dispatch',
        ),
        true,
      ),
    ).toMatchObject({
      status: 'failed',
      publicFailure: {
        code: 'provider_failed',
        retryable: true,
        outcomeReason: 'connection_unavailable_before_dispatch',
      },
    });
  });

  it('keeps an after-dispatch timeout unknown and non-retryable', () => {
    expect(
      projectToolFailure(
        new ToolExecutionError(
          'provider timed out after dispatch',
          'unknown',
          'timeout_after_dispatch',
        ),
        true,
      ),
    ).toMatchObject({
      status: 'outcome_unknown',
      publicFailure: {
        code: 'outcome_unknown',
        retryable: false,
        outcomeReason: 'timeout_after_dispatch',
      },
    });
  });

  it('uses side-effect risk instead of message text for untyped errors', () => {
    expect(projectToolFailure(new Error('same provider error'), false).status).toBe('failed');
    expect(projectToolFailure(new Error('same provider error'), true).status).toBe(
      'outcome_unknown',
    );
  });
});

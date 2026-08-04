import { describe, expect, it } from 'vitest';

import { noticeMessage, recoveryAction } from './agent-notice-part';

const part = (status: string, type: 'warning' | 'recovery' = 'warning') => ({
  id: 'part-1',
  runId: 'run-1',
  sequence: 1,
  type,
  status,
  payload: {},
});

describe('noticeMessage', () => {
  it('keeps recovery, cancellation, degradation, and protocol failures distinct', () => {
    expect(noticeMessage(part('run.recovering', 'recovery'), '', {})).toContain('恢复');
    expect(noticeMessage(part('run.cancelled'), '', {})).toContain('停止');
    expect(noticeMessage(part('run.completed_with_degradation'), '', {})).toContain('警告');
    expect(noticeMessage(part('run.failed'), 'protocol_error', {})).toContain('协议');
    expect(
      noticeMessage(
        { ...part('run.failed'), payload: { pendingDraft: true } },
        'runtime_error',
        {},
      ),
    ).toContain('草稿仍已保留');
  });

  it('maps terminal failures to explicit regenerate actions', () => {
    expect(recoveryAction(part('run.failed'), 'provider_error')?.label).toBe('重试');
    expect(recoveryAction(part('article.stale'), 'stale_revision')?.label).toBe(
      '基于最新正文重试',
    );
    expect(recoveryAction(part('run.cancelled'), '')?.label).toBe('重新开始');
    expect(recoveryAction(part('run.completed_with_degradation'), '')?.label).toBe(
      '重新生成完整结果',
    );
    expect(recoveryAction(part('run.recovering', 'recovery'), '')).toBeUndefined();
  });

  it('does not expose internal runtime payloads', () => {
    expect(
      noticeMessage(part('run.failed'), 'runtime_error', {
        message: 'Failed query toolCallId=secret',
      }),
    ).toBe('运行服务暂时不可用，请稍后重试。');
  });
});

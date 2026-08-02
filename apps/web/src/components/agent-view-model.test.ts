import { describe, expect, it } from 'vitest';

import { activityLabel, safeExternalUrl, statusLabel } from './agent-view-model';

describe('agent view model', () => {
  it('turns internal run states into consumer-facing copy', () => {
    expect(statusLabel('run.failed')).toBe('本次处理未完成');
    expect(statusLabel('run.waiting_for_user')).toBe('等待你的回答');
    expect(statusLabel('unknown.internal_state')).toBe('正在处理');
  });

  it('does not expose tool identifiers as activity titles', () => {
    expect(
      activityLabel({
        id: 'part-1',
        runId: 'run-1',
        sequence: 1,
        type: 'activity',
        status: 'tool.executing',
        payload: { toolId: 'internal.search@1.0.0' },
      }),
    ).toBe('正在使用所需工具');
  });

  it('only exposes navigable web links', () => {
    expect(safeExternalUrl('https://example.com/source')).toBe('https://example.com/source');
    expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeExternalUrl('not a link')).toBeUndefined();
  });
});

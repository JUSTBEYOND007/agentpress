import { describe, expect, it } from 'vitest';

import { activityLabel, proposalFromPart, safeExternalUrl, statusLabel } from './agent-view-model';

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

  it('labels unknown ToolCall outcomes for human reconciliation', () => {
    expect(statusLabel('tool.outcome_unknown')).toBe('结果待核对');
    expect(
      activityLabel({
        id: 'tool-unknown',
        runId: 'run-1',
        sequence: 1,
        type: 'activity',
        status: 'tool.outcome_unknown',
        outcome: 'outcome_unknown',
        payload: {},
      }),
    ).toBe('结果待核对');
  });

  it('only exposes navigable web links', () => {
    expect(safeExternalUrl('https://example.com/source')).toBe('https://example.com/source');
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      '//attacker.example/path',
      'https://trusted.example@attacker.example/path',
      'not a link',
    ]) {
      expect(safeExternalUrl(hostile)).toBeUndefined();
    }
  });

  it('only opens proposals whose persisted status is pending', () => {
    const part = {
      id: 'part-1',
      runId: 'run-1',
      sequence: 1,
      type: 'activity' as const,
      status: 'tool.succeeded',
      payload: {
        proposalStatus: 'pending',
        output: { proposalId: 'proposal-1', operations: [], diffs: [] },
      },
    };
    expect(proposalFromPart(part)).toMatchObject({ proposalId: 'proposal-1', status: 'pending' });
    expect(
      proposalFromPart({ ...part, payload: { ...part.payload, proposalStatus: 'accepted' } }),
    ).toMatchObject({ proposalId: 'proposal-1', status: 'accepted' });
  });
});

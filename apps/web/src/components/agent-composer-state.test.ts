import { describe, expect, it } from 'vitest';

import { composerDraftStorageKey, deriveAgentComposerState } from './agent-composer-state';

const activeDirectRun = { mode: 'direct' as const, status: 'running', terminal: false };
const activePlannedRun = { mode: 'planned' as const, status: 'running', terminal: false };

describe('Agent composer lifecycle', () => {
  it('keeps a new Run, steering, and follow-up as distinct submissions', () => {
    expect(
      deriveAgentComposerState({
        readiness: 'ready',
        hasConversation: true,
        uploadingAttachments: 0,
        sendMode: 'steering',
      }).submissionKind,
    ).toBe('new_run');
    expect(
      deriveAgentComposerState({
        readiness: 'ready',
        hasConversation: true,
        uploadingAttachments: 0,
        activeRun: activeDirectRun,
        sendMode: 'steering',
      }).submissionKind,
    ).toBe('steering');
    expect(
      deriveAgentComposerState({
        readiness: 'ready',
        hasConversation: true,
        uploadingAttachments: 0,
        activeRun: activeDirectRun,
        sendMode: 'follow-up',
      }).submissionKind,
    ).toBe('follow_up');
  });

  it('distinguishes stopping direct generation from cancelling a planned Run', () => {
    const direct = deriveAgentComposerState({
      readiness: 'ready',
      hasConversation: true,
      uploadingAttachments: 0,
      activeRun: activeDirectRun,
      sendMode: 'steering',
    });
    const planned = deriveAgentComposerState({
      readiness: 'ready',
      hasConversation: true,
      uploadingAttachments: 0,
      activeRun: activePlannedRun,
      sendMode: 'steering',
    });
    expect(direct.termination).toMatchObject({ kind: 'stop_generation', label: '停止生成' });
    expect(planned.termination).toMatchObject({ kind: 'cancel_run', label: '取消任务' });
  });

  it('disables all new input while cancellation is settling', () => {
    const state = deriveAgentComposerState({
      readiness: 'ready',
      hasConversation: true,
      uploadingAttachments: 0,
      activeRun: { mode: 'planned', status: 'cancelling', terminal: false },
      sendMode: 'follow-up',
    });
    expect(state.sendDisabledReason).toBe('当前任务正在取消');
    expect(state.termination).toEqual({ kind: 'cancelling', label: '正在取消', disabled: true });
  });

  it('reports the exact host-side reason that sending is disabled', () => {
    expect(
      deriveAgentComposerState({
        readiness: 'ready',
        hasConversation: true,
        uploadingAttachments: 2,
        sendMode: 'steering',
      }).sendDisabledReason,
    ).toBe('附件仍在解析');
  });

  it('isolates drafts at the immutable conversation branch boundary', () => {
    expect(composerDraftStorageKey('conversation-1:branch-a')).not.toBe(
      composerDraftStorageKey('conversation-1:branch-b'),
    );
  });
});

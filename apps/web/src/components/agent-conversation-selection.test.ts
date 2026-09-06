import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chooseConversation,
  conversationSelectionStorageKey,
  readConversationSelection,
  resolveConversationSelection,
  writeConversationSelection,
} from './agent-conversation-selection';
import type { ConversationView } from './agent-view-model';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conversation selection persistence', () => {
  const conversations: readonly ConversationView[] = [
    { id: 'conversation', branchId: 'original', title: 'Original', isDefault: true },
    { id: 'conversation', branchId: 'fork', title: 'Fork', isDefault: false },
  ];

  it('restores only a branch that still belongs to the article conversation list', () => {
    expect(
      chooseConversation(conversations, [{ conversationId: 'conversation', branchId: 'fork' }]),
    ).toEqual(conversations[1]);
    expect(
      chooseConversation(conversations, [
        { conversationId: 'forged', branchId: 'outside-workspace' },
      ]),
    ).toEqual(conversations[0]);
  });

  it('prefers the persisted branch on first load and the current branch on later refreshes', () => {
    const initial = { conversationId: 'conversation', branchId: 'original' };
    const persisted = { conversationId: 'conversation', branchId: 'fork' };

    expect(
      resolveConversationSelection(conversations, {
        firstLoad: true,
        initial,
        persisted,
      }),
    ).toEqual(conversations[1]);
    expect(
      resolveConversationSelection(conversations, {
        current: initial,
        firstLoad: false,
        initial,
        persisted,
      }),
    ).toEqual(conversations[0]);
  });

  it('persists only the UI selection pointer under its article or workspace boundary', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      },
    });
    const selection = { conversationId: 'conversation', branchId: 'fork' };
    writeConversationSelection('article-1', selection);
    expect(readConversationSelection('article-1')).toEqual(selection);
    expect(readConversationSelection('article-2')).toBeUndefined();
    expect(readConversationSelection('workspace:workspace-1')).toBeUndefined();
    expect([...values.keys()]).toEqual([conversationSelectionStorageKey('article-1')]);
  });

  it('ignores malformed or unavailable browser storage', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => '{invalid',
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(readConversationSelection('article')).toBeUndefined();
    expect(() => {
      writeConversationSelection('article', { conversationId: 'c', branchId: 'b' });
    }).not.toThrow();
  });
});

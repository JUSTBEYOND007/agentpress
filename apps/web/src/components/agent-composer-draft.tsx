'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import { useEffect, useRef } from 'react';

import { composerDraftStorageKey } from './agent-composer-state';

export function AgentComposerDraft({ threadKey }: { readonly threadKey?: string }): null {
  const aui = useAui();
  const value = useAuiState((state) => state.composer.text);
  const activeKey = useRef<string | null>(null);
  const skippedValue = useRef<string | null>(null);
  const currentValue = useRef(value);
  currentValue.current = value;

  useEffect(() => {
    const key = threadKey ? composerDraftStorageKey(threadKey) : null;
    activeKey.current = key;
    skippedValue.current = currentValue.current;
    try {
      aui.composer.setText(key ? (window.localStorage.getItem(key) ?? '') : '');
    } catch {
      aui.composer.setText('');
    }
  }, [aui, threadKey]);

  useEffect(() => {
    if (skippedValue.current === value) {
      skippedValue.current = null;
      return;
    }
    const key = activeKey.current;
    if (!key) return;
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch {
      // Draft persistence is best-effort when browser storage is unavailable.
    }
  }, [value]);

  return null;
}

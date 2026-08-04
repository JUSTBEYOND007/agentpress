import { describe, expect, it } from 'vitest';

import { markdownModeForStatus } from './agent-message-content';

describe('markdownModeForStatus', () => {
  it('uses incremental parsing only while the message part is running', () => {
    expect(markdownModeForStatus('running')).toBe('streaming');
    expect(markdownModeForStatus('complete')).toBe('static');
    expect(markdownModeForStatus('incomplete')).toBe('static');
  });
});

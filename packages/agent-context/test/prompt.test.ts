import { describe, expect, it } from 'vitest';

import { composePromptBlocks, renderPromptTemplate } from '../src/prompt.js';

describe('prompt composition', () => {
  it('renders explicit variables and preserves block order', () => {
    expect(
      composePromptBlocks([
        { id: 'role', content: 'You are a writer.' },
        { id: 'context', content: renderPromptTemplate('Date: {{date}}', { date: '2026-08-04' }) },
        { id: 'disabled', content: 'ignore', enabled: false },
      ]),
    ).toBe('You are a writer.\n\nDate: 2026-08-04');
  });

  it('fails closed on missing variables, duplicate IDs, and empty blocks', () => {
    expect(() => renderPromptTemplate('Use {{missing}}.', {})).toThrow('missing');
    expect(() => composePromptBlocks([{ id: 'same', content: 'a' }, { id: 'same', content: 'b' }])).toThrow('duplicated');
    expect(() => composePromptBlocks([{ id: 'empty', content: ' ' }])).toThrow('empty');
  });
});


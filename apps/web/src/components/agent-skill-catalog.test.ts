import { describe, expect, it } from 'vitest';

import { skillCommandDescription } from './agent-composer';

const skill = {
  skillId: 'research',
  version: '1.0.0',
  description: 'Collect reliable sources',
} as const;

describe('Skill catalog presentation', () => {
  it('distinguishes selectable, explicit-only, and failed Skills', () => {
    expect(skillCommandDescription({ ...skill, status: 'available' }, false)).toBe(
      'Collect reliable sources',
    );
    expect(skillCommandDescription({ ...skill, status: 'policy_disabled' }, false)).toContain(
      '仅用户显式选择',
    );
    expect(skillCommandDescription({ ...skill, status: 'load_failed' }, false)).toBe(
      '加载失败，无法绑定',
    );
  });
});

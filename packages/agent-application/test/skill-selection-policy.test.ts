import { describe, expect, it } from 'vitest';

import type { SkillPreselectionCandidate } from '../src/contracts.js';
import {
  collectSkillSelections,
  mergeSkillSelections,
  validateModelSkillSelections,
} from '../src/skill-selection-policy.js';

const candidates: readonly SkillPreselectionCandidate[] = [
  {
    skillId: 'available',
    version: '1.0.0',
    description: 'Available to the model',
    allowedTools: [],
    hidden: false,
    disableModelInvocation: false,
  },
  {
    skillId: 'hidden',
    version: '1.0.0',
    description: 'Hidden from the model',
    allowedTools: [],
    hidden: true,
    disableModelInvocation: false,
  },
  {
    skillId: 'explicit-only',
    version: '1.0.0',
    description: 'Only valid when the host selects it explicitly',
    allowedTools: [],
    hidden: false,
    disableModelInvocation: true,
  },
];

describe('Skill selection policy', () => {
  it('rejects conflicting explicit revisions across input and context binding', () => {
    expect(() =>
      collectSkillSelections({
        conversationId: 'conversation',
        branchId: 'branch',
        userId: 'user',
        prompt: 'Use the Skill',
        idempotencyKey: 'request',
        skills: [{ skillId: 'available', version: '1.0.0' }],
        contextBindings: [{ type: 'skill', skillId: 'available', version: '2.0.0' }],
      }),
    ).toThrow('Skill available cannot use multiple revisions in one Run');
  });

  it('keeps explicit authority and returns a stable Skill ID order', () => {
    expect(
      mergeSkillSelections(
        [{ skillId: 'z-explicit', version: '2.0.0' }],
        [
          { skillId: 'z-explicit', version: '1.0.0' },
          { skillId: 'a-model', version: '1.0.0' },
        ],
      ),
    ).toEqual([
      { skillId: 'a-model', version: '1.0.0' },
      { skillId: 'z-explicit', version: '2.0.0' },
    ]);
  });

  it.each([
    ['unknown', '1.0.0'],
    ['available', '2.0.0'],
    ['hidden', '1.0.0'],
    ['explicit-only', '1.0.0'],
  ])('rejects model authority for unavailable selection %s@%s', (skillId, version) => {
    expect(() => validateModelSkillSelections(candidates, [{ skillId, version }])).toThrow(
      `Model selected unavailable Skill ${skillId}@${version}`,
    );
  });

  it('rejects duplicate model selections even when their revision is valid', () => {
    expect(() =>
      validateModelSkillSelections(candidates, [
        { skillId: 'available', version: '1.0.0' },
        { skillId: 'available', version: '1.0.0' },
      ]),
    ).toThrow('Model selected Skill available more than once');
  });
});

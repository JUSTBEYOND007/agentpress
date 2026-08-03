import { describe, expect, it } from 'vitest';

import { branchNavigationView } from './agent-branch-navigator';

describe('branchNavigationView', () => {
  it('orders sibling branches by their immutable creation facts', () => {
    const original = {
      id: 'c',
      branchId: 'b1',
      title: 'Chat',
      isDefault: true,
      branchCreatedAt: '2026-01-01',
    };
    const fork = {
      ...original,
      branchId: 'b2',
      parentBranchId: 'b1',
      forkedFromMessageId: 'm1',
      branchCreatedAt: '2026-01-02',
    };
    expect(branchNavigationView([fork, original], fork)).toMatchObject({
      index: 1,
      previous: original,
      next: undefined,
    });
  });
});

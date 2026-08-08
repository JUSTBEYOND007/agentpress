import { loadSkill } from '@agentpress/agent-context';
import { type DatabaseTransaction, skillRevisions } from '@agentpress/database';
import { desc, eq } from 'drizzle-orm';

import {
  AgentApplicationError,
  type CreateDirectRunInput,
  type SelectedSkillInput,
  type SkillCatalogFailure,
  type SkillPreselectionCandidate,
} from './contracts.js';

export type SkillPreselectionCatalog = {
  readonly candidates: readonly SkillPreselectionCandidate[];
  readonly failures: readonly SkillCatalogFailure[];
};

export function collectSkillSelections(input: CreateDirectRunInput): readonly SelectedSkillInput[] {
  return normalizeSkillSelections([
    ...(input.skills ?? []),
    ...(input.contextBindings ?? []).flatMap((binding) =>
      binding.type === 'skill' ? [{ skillId: binding.skillId, version: binding.version }] : [],
    ),
  ]);
}

export function mergeSkillSelections(
  explicit: readonly SelectedSkillInput[],
  model: readonly SelectedSkillInput[],
): readonly SelectedSkillInput[] {
  const selected = new Map(normalizeSkillSelections(explicit).map((item) => [item.skillId, item]));
  for (const selection of model) {
    if (!selected.has(selection.skillId)) selected.set(selection.skillId, selection);
  }
  if (selected.size > 8) {
    throw new AgentApplicationError('invalid_context', 'A Run can select at most 8 Skills');
  }
  return [...selected.values()].sort((left, right) => left.skillId.localeCompare(right.skillId));
}

export function validateModelSkillSelections(
  candidates: readonly SkillPreselectionCandidate[],
  selections: readonly SelectedSkillInput[],
): readonly SelectedSkillInput[] {
  const byId = new Map(candidates.map((candidate) => [candidate.skillId, candidate]));
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.skillId)) {
      throw new AgentApplicationError(
        'invalid_context',
        `Model selected Skill ${selection.skillId} more than once`,
      );
    }
    seen.add(selection.skillId);
    const candidate = byId.get(selection.skillId);
    if (
      candidate?.version !== selection.version ||
      candidate.hidden ||
      candidate.disableModelInvocation
    ) {
      throw new AgentApplicationError(
        'invalid_context',
        `Model selected unavailable Skill ${selection.skillId}@${selection.version}`,
      );
    }
  }
  return [...selections];
}

export async function loadSkillPreselectionCatalog(
  transaction: DatabaseTransaction,
  workspaceId: string,
): Promise<SkillPreselectionCatalog> {
  const rows = await transaction
    .select()
    .from(skillRevisions)
    .where(eq(skillRevisions.workspaceId, workspaceId))
    .orderBy(skillRevisions.skillId, desc(skillRevisions.createdAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latest.has(row.skillId)) latest.set(row.skillId, row);
  }
  const candidates: SkillPreselectionCandidate[] = [];
  const failures: SkillCatalogFailure[] = [];
  for (const row of latest.values()) {
    let skill: ReturnType<typeof loadSkill>;
    try {
      skill = loadSkill(row.content);
    } catch {
      failures.push({ skillId: row.skillId, version: row.version, code: 'load_failed' });
      continue;
    }
    if (skill.id !== row.skillId || skill.version !== row.version) {
      failures.push({ skillId: row.skillId, version: row.version, code: 'identity_mismatch' });
      continue;
    }
    candidates.push({
      skillId: row.skillId,
      version: row.version,
      description: skill.description,
      allowedTools: row.allowedTools,
      hidden: skill.hidden === true,
      disableModelInvocation: skill.disableModelInvocation === true,
    });
  }
  return { candidates, failures };
}

function normalizeSkillSelections(
  selections: readonly SelectedSkillInput[],
): readonly SelectedSkillInput[] {
  const selected = new Map<string, SelectedSkillInput>();
  for (const selection of selections) {
    const current = selected.get(selection.skillId);
    if (current && current.version !== selection.version) {
      throw new AgentApplicationError(
        'invalid_context',
        `Skill ${selection.skillId} cannot use multiple revisions in one Run`,
      );
    }
    selected.set(selection.skillId, selection);
  }
  return [...selected.values()];
}

import {
  hashSkillRevisionContent,
  loadSkill,
  loadStaticSkillResources,
  type SkillDefinition,
} from '@agentpress/agent-context';
import {
  type DatabaseTransaction,
  runSkillBindings,
  skillRevisionResources,
  skillRevisions,
} from '@agentpress/database';
import { and, eq, inArray } from 'drizzle-orm';

import { AgentApplicationError, type SelectedSkillInput } from './contracts.js';

export type RunSkillResource = {
  readonly skillRevisionId: string;
  readonly path: string;
  readonly content: string;
  readonly contentHash: string;
  readonly byteSize: number;
};

export type RunSkillContext = {
  readonly revisions: readonly (typeof skillRevisions.$inferSelect)[];
  readonly resources: readonly RunSkillResource[];
  readonly skills: readonly SkillDefinition[];
};

export async function loadRunSkillContext(
  transaction: DatabaseTransaction,
  workspaceId: string,
  selections: readonly SelectedSkillInput[],
): Promise<RunSkillContext> {
  const requestedSkillIds = [...new Set(selections.map(({ skillId }) => skillId))];
  const availableRevisions =
    requestedSkillIds.length === 0
      ? []
      : await transaction
          .select()
          .from(skillRevisions)
          .where(
            and(
              eq(skillRevisions.workspaceId, workspaceId),
              inArray(skillRevisions.skillId, requestedSkillIds),
            ),
          );
  const revisions = selections.map((selection) => {
    const revision = availableRevisions.find(
      (candidate) =>
        candidate.skillId === selection.skillId && candidate.version === selection.version,
    );
    if (!revision) {
      throw new AgentApplicationError(
        'unauthorized_context',
        `Skill ${selection.skillId}@${selection.version} is unavailable`,
      );
    }
    return revision;
  });
  const resources =
    revisions.length === 0
      ? []
      : await transaction
          .select({
            skillRevisionId: skillRevisionResources.skillRevisionId,
            path: skillRevisionResources.path,
            content: skillRevisionResources.content,
            contentHash: skillRevisionResources.contentHash,
            byteSize: skillRevisionResources.byteSize,
          })
          .from(skillRevisionResources)
          .where(
            inArray(
              skillRevisionResources.skillRevisionId,
              revisions.map(({ id }) => id),
            ),
          );
  const skills = revisions.map((revision) =>
    validateStoredSkill(
      revision,
      resources.filter(({ skillRevisionId }) => skillRevisionId === revision.id),
    ),
  );
  return { revisions, resources, skills };
}

export async function persistRunSkillBindings(
  transaction: DatabaseTransaction,
  runId: string,
  revisions: readonly (typeof skillRevisions.$inferSelect)[],
): Promise<void> {
  if (revisions.length === 0) return;
  await transaction.insert(runSkillBindings).values(
    revisions.map((revision) => ({
      runId,
      skillRevisionId: revision.id,
      contentHash: revision.contentHash,
      allowedTools: revision.allowedTools,
    })),
  );
}

function validateStoredSkill(
  row: typeof skillRevisions.$inferSelect,
  resourceRows: readonly RunSkillResource[],
): SkillDefinition {
  const skill = loadSkill(row.content);
  const resources = loadStaticSkillResources(
    skill,
    resourceRows.map((resource) => ({
      path: resource.path,
      content: resource.content,
      fileType: 'file',
    })),
  );
  const resourcesValid =
    resources.length === resourceRows.length &&
    resources.every((resource) => {
      const persisted = resourceRows.find(({ path }) => path === resource.path);
      return (
        persisted?.contentHash === resource.contentHash &&
        persisted.byteSize === Buffer.byteLength(resource.content, 'utf8')
      );
    });
  const contentHash = hashSkillRevisionContent(row.content, resources);
  if (
    skill.id !== row.skillId ||
    skill.version !== row.version ||
    contentHash !== row.contentHash ||
    !resourcesValid ||
    JSON.stringify(skill.allowedTools) !== JSON.stringify([...row.allowedTools].sort())
  ) {
    throw new Error(`Stored Skill ${row.skillId}@${row.version} failed integrity validation`);
  }
  return skill;
}

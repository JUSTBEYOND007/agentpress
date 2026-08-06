import {
  hashSkillRevisionContent,
  loadSkill,
  loadStaticSkillResources,
  type ContextCandidate,
  type ContextOrigin,
  type SkillDefinition,
} from '@agentpress/agent-context';
import {
  articleRevisions,
  articles,
  type DatabaseTransaction,
  skillRevisions,
} from '@agentpress/database';
import { hashBlock, type EditorBlock } from '@agentpress/editor-patch';
import { and, eq } from 'drizzle-orm';

import {
  AgentApplicationError,
  type RunContextBinding,
  type SelectedSkillInput,
} from './contracts.js';

export function validateStoredSkill(
  row: typeof skillRevisions.$inferSelect,
  resourceRows: readonly {
    readonly path: string;
    readonly content: string;
    readonly contentHash: string;
    readonly byteSize: number;
  }[],
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
  )
    throw new Error(`Stored Skill ${row.skillId}@${row.version} failed integrity validation`);
  return skill;
}

export function contextCandidate(
  id: string,
  kind: ContextCandidate['kind'],
  content: string,
  revision: string,
  score: number,
  policy: { readonly required: boolean; readonly trusted: boolean },
): ContextCandidate {
  return {
    id,
    kind,
    content,
    revision,
    tokenCount: Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4)),
    score,
    trusted: policy.trusted,
    trust: policy.trusted ? 'trusted' : 'untrusted',
    origin: contextOrigin(kind, id),
    owner: 'run-context',
    selectionReason: policy.required ? 'required-host-binding' : 'deterministic-relevance',
    truncated: false,
    required: policy.required,
  };
}

function contextOrigin(kind: ContextCandidate['kind'], id: string): ContextOrigin {
  if (id.startsWith('skill:') || id.startsWith('skill-resource:')) return 'skill';
  if (id.startsWith('evidence:')) return 'evidence';
  if (id.startsWith('attachment:')) return 'attachment';
  if (id.startsWith('conversation-')) return 'conversation_history';
  if (id.startsWith('article:')) return 'host_context';
  if (kind === 'memory') return 'memory';
  if (kind === 'policy') return 'system_policy';
  return 'host_context';
}

export function escapeUntrustedContext(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function uniqueSkills(values: readonly SelectedSkillInput[]): readonly SelectedSkillInput[] {
  return [...new Map(values.map((skill) => [`${skill.skillId}@${skill.version}`, skill])).values()];
}

type ArticleContextBinding = Extract<
  RunContextBinding,
  { readonly type: 'article_revision' | 'article_selection' }
>;

export function normalizeBindings(bindings: readonly RunContextBinding[]) {
  return {
    mentionTargetIds: bindings.flatMap((binding) =>
      binding.type === 'mention' ? [binding.targetId] : [],
    ),
    attachmentIds: bindings.flatMap((binding) =>
      binding.type === 'attachment' ? [binding.attachmentId] : [],
    ),
    evidenceIds: unique(
      bindings.flatMap((binding) => (binding.type === 'evidence' ? [binding.evidenceId] : [])),
    ),
    skills: bindings.flatMap((binding) =>
      binding.type === 'skill' ? [{ skillId: binding.skillId, version: binding.version }] : [],
    ),
    articleBindings: bindings.filter(
      (binding): binding is ArticleContextBinding =>
        binding.type === 'article_revision' || binding.type === 'article_selection',
    ),
  };
}

export async function loadBoundArticleContent(
  transaction: DatabaseTransaction,
  workspaceId: string,
  bindings: readonly ArticleContextBinding[],
) {
  const result = [];
  for (const binding of bindings) {
    const rows = await transaction
      .select({ document: articleRevisions.document, contentHash: articleRevisions.documentHash })
      .from(articleRevisions)
      .innerJoin(articles, eq(articles.id, articleRevisions.articleId))
      .where(
        and(
          eq(articles.workspaceId, workspaceId),
          eq(articles.id, binding.articleId),
          eq(articleRevisions.id, binding.revisionId),
        ),
      )
      .limit(1);
    const revision = rows[0];
    if (!revision)
      throw new AgentApplicationError(
        'unauthorized_context',
        'An article revision is missing or outside the current workspace',
      );
    if (binding.type === 'article_revision') {
      result.push({
        id: `article-revision:${binding.revisionId}`,
        articleId: binding.articleId,
        revisionId: binding.revisionId,
        contentHash: revision.contentHash,
        content: JSON.stringify(revision.document),
        revision: `${binding.revisionId}:${revision.contentHash}`,
      });
      continue;
    }
    const document = revision.document as {
      readonly content?: readonly { readonly attrs?: Readonly<Record<string, unknown>> }[];
    };
    const blocks = binding.blocks.map(({ blockId, contentHash }) => {
      const block = document.content?.find((candidate) => candidate.attrs?.blockId === blockId);
      if (!block || hashBlock(block as EditorBlock) !== contentHash)
        throw new AgentApplicationError(
          'invalid_context',
          `Article selection block ${blockId} is stale or missing`,
        );
      return block;
    });
    result.push({
      id: `article-selection:${binding.articleId}:${binding.revisionId}`,
      articleId: binding.articleId,
      revisionId: binding.revisionId,
      contentHash: revision.contentHash,
      content: JSON.stringify({ type: 'doc', content: blocks }),
      revision: `${binding.revisionId}:${blocks.map((block) => hashBlock(block as EditorBlock)).join(':')}`,
    });
  }
  return result;
}

import { randomUUID } from 'node:crypto';

import {
  assembleContext,
  createPromptRevision,
  loadSkill,
  pinSkills,
  rankRelevantMemory,
  type ContextCandidate,
  type ContextPack,
  type SkillDefinition,
} from '@agentpress/agent-context';
import {
  articleRevisions,
  agentRuns,
  articles,
  type AgentPressDatabase,
  type DatabaseTransaction,
  conversationCompactions,
  memoryCandidates,
  mentionBindings,
  evidenceRecords,
  promptRevisions,
  runAttachments,
  runContextPacks,
  runSkillBindings,
  skillRevisionResources,
  skillRevisions,
} from '@agentpress/database';
import { hashBlock, type EditorBlock } from '@agentpress/editor-patch';
import { and, desc, eq, gt, inArray, isNull, lt, lte, or } from 'drizzle-orm';

import {
  AgentApplicationError,
  type RunContextBinding,
  type SelectedSkillInput,
} from './contracts.js';

export class RunContextService {
  private readonly createId: () => string;
  private readonly prompt;

  public constructor(
    private readonly database: AgentPressDatabase,
    systemPrompt: string,
    private readonly contextWindow = 128_000,
    createId: () => string = randomUUID,
  ) {
    this.createId = createId;
    const identity = createPromptRevision('agentpress.main', 'unversioned', systemPrompt);
    this.prompt = createPromptRevision(
      'agentpress.main',
      `1.0.0-${identity.contentHash.slice(0, 12)}`,
      systemPrompt,
    );
  }

  public async prepare(
    transaction: DatabaseTransaction,
    input: {
      readonly runId: string;
      readonly branchId: string;
      readonly rootMessageSequence: number;
      readonly query: string;
      readonly workspaceId: string;
      readonly userId: string;
      readonly mentionTargetIds: readonly string[];
      readonly attachmentIds: readonly string[];
      readonly skills: readonly SelectedSkillInput[];
      readonly contextBindings: readonly RunContextBinding[];
    },
  ): Promise<ContextPack> {
    const normalized = normalizeBindings(input.contextBindings);
    const mentions = unique([...input.mentionTargetIds, ...normalized.mentionTargetIds]);
    const attachmentIds = unique([...input.attachmentIds, ...normalized.attachmentIds]);
    const selectedSkills = uniqueSkills([...input.skills, ...normalized.skills]);
    if (mentions.length > 20)
      throw new AgentApplicationError('invalid_context', 'A Run can bind at most 20 Mentions');
    if (selectedSkills.length > 8)
      throw new AgentApplicationError('invalid_context', 'A Run can select at most 8 Skills');
    if (attachmentIds.length > 10)
      throw new AgentApplicationError('invalid_context', 'A Run can bind at most 10 attachments');

    const mentionRows =
      mentions.length === 0
        ? []
        : await transaction
            .select({
              id: articles.id,
              revisionId: articleRevisions.id,
              document: articleRevisions.document,
              contentHash: articleRevisions.documentHash,
            })
            .from(articles)
            .innerJoin(articleRevisions, eq(articleRevisions.id, articles.currentRevisionId))
            .where(
              and(eq(articles.workspaceId, input.workspaceId), inArray(articles.id, mentions)),
            );
    if (mentionRows.length !== mentions.length)
      throw new AgentApplicationError(
        'unauthorized_context',
        'A Mention is missing or outside the current workspace',
      );
    const attachmentRows =
      attachmentIds.length === 0
        ? []
        : await transaction
            .select({
              id: runAttachments.id,
              filename: runAttachments.filename,
              content: runAttachments.extractedText,
              contentHash: runAttachments.contentHash,
              parseStatus: runAttachments.parseStatus,
            })
            .from(runAttachments)
            .where(
              and(
                eq(runAttachments.workspaceId, input.workspaceId),
                inArray(runAttachments.id, attachmentIds),
              ),
            );
    if (
      attachmentRows.length !== attachmentIds.length ||
      attachmentRows.some(({ parseStatus, content }) => parseStatus !== 'ready' || content === null)
    ) {
      throw new AgentApplicationError(
        'unauthorized_context',
        'An attachment is missing, outside the workspace, or not ready',
      );
    }

    const articleBindings = await loadBoundArticleContent(
      transaction,
      input.workspaceId,
      normalized.articleBindings,
    );
    const evidenceRows =
      normalized.evidenceIds.length === 0
        ? []
        : await transaction
            .select({
              id: evidenceRecords.id,
              title: evidenceRecords.title,
              excerpt: evidenceRecords.excerpt,
              sourceRevision: evidenceRecords.sourceRevision,
            })
            .from(evidenceRecords)
            .innerJoin(agentRuns, eq(agentRuns.id, evidenceRecords.runId))
            .where(
              and(
                inArray(evidenceRecords.id, normalized.evidenceIds),
                eq(agentRuns.workspaceId, input.workspaceId),
              ),
            );
    if (evidenceRows.length !== normalized.evidenceIds.length)
      throw new AgentApplicationError(
        'unauthorized_context',
        'An Evidence binding is missing or outside the current workspace',
      );

    const requestedSkillIds = unique(selectedSkills.map(({ skillId }) => skillId));
    const availableSkillRows =
      requestedSkillIds.length === 0
        ? []
        : await transaction
            .select()
            .from(skillRevisions)
            .where(
              and(
                eq(skillRevisions.workspaceId, input.workspaceId),
                inArray(skillRevisions.skillId, requestedSkillIds),
              ),
            );
    const selectedSkillRows = selectedSkills.map((selection) => {
      const row = availableSkillRows.find(
        (candidate) =>
          candidate.skillId === selection.skillId && candidate.version === selection.version,
      );
      if (!row)
        throw new AgentApplicationError(
          'unauthorized_context',
          `Skill ${selection.skillId}@${selection.version} is unavailable`,
        );
      return row;
    });
    const parsedSkills = selectedSkillRows.map(validateStoredSkill);
    const skillResourceRows =
      selectedSkillRows.length === 0
        ? []
        : await transaction
            .select({
              skillRevisionId: skillRevisionResources.skillRevisionId,
              path: skillRevisionResources.path,
              content: skillRevisionResources.content,
              contentHash: skillRevisionResources.contentHash,
            })
            .from(skillRevisionResources)
            .where(
              inArray(
                skillRevisionResources.skillRevisionId,
                selectedSkillRows.map(({ id }) => id),
              ),
            );
    const now = new Date();
    const acceptedMemoryRows = await transaction
      .select()
      .from(memoryCandidates)
      .where(
        and(
          eq(memoryCandidates.workspaceId, input.workspaceId),
          eq(memoryCandidates.userId, input.userId),
          eq(memoryCandidates.status, 'accepted'),
          or(lte(memoryCandidates.validFrom, now), isNull(memoryCandidates.validFrom)),
          or(gt(memoryCandidates.validUntil, now), isNull(memoryCandidates.validUntil)),
        ),
      )
      .orderBy(desc(memoryCandidates.updatedAt))
      .limit(500);
    const memoryHits = rankRelevantMemory(
      input.workspaceId,
      input.query,
      acceptedMemoryRows.map((memory) => ({
        id: memory.id,
        workspaceId: memory.workspaceId,
        userId: memory.userId,
        subject: memory.subject,
        value: memory.value,
        valueHash: memory.valueHash,
        status: memory.status,
        confidence: memory.confidenceBps / 10_000,
        kind: memory.kind,
        importance: memory.importanceBps / 10_000,
        ...(memory.validFrom ? { validFrom: memory.validFrom.toISOString() } : {}),
        ...(memory.validUntil ? { validUntil: memory.validUntil.toISOString() } : {}),
        sourceEvidenceIds: memory.sourceEvidenceIds,
        ...(memory.supersedesId ? { supersedesId: memory.supersedesId } : {}),
        updatedAt: memory.updatedAt.toISOString(),
      })),
      { userId: input.userId, now, limit: 8 },
    );
    const compactionRows = await transaction
      .select()
      .from(conversationCompactions)
      .where(
        and(
          eq(conversationCompactions.branchId, input.branchId),
          eq(conversationCompactions.status, 'completed'),
          lt(conversationCompactions.sourceThroughSequence, input.rootMessageSequence),
          lte(conversationCompactions.firstKeptMessageSequence, input.rootMessageSequence),
        ),
      )
      .orderBy(desc(conversationCompactions.version))
      .limit(1);
    const compaction = compactionRows[0];
    const candidates: ContextCandidate[] = [
      contextCandidate(
        `prompt:${this.prompt.promptId}`,
        'policy',
        'The versioned system policy is supplied separately by the runtime.',
        `${this.prompt.version}:${this.prompt.contentHash}`,
        1,
        true,
      ),
      ...parsedSkills.map((skill) =>
        contextCandidate(
          `skill:${skill.id}`,
          'policy',
          skill.instructions,
          skill.version,
          0.9,
          false,
          false,
        ),
      ),
      ...skillResourceRows.map((resource) =>
        contextCandidate(
          `skill-resource:${resource.skillRevisionId}:${resource.path}`,
          'attachment',
          resource.content,
          resource.contentHash,
          0.85,
          false,
          false,
        ),
      ),
      ...mentionRows.map((mention) =>
        contextCandidate(
          `article:${mention.id}`,
          'mention',
          JSON.stringify(mention.document),
          `${mention.revisionId}:${mention.contentHash}`,
          1,
          true,
        ),
      ),
      ...attachmentRows.map((attachment) =>
        contextCandidate(
          `attachment:${attachment.id}`,
          'attachment',
          attachment.content ?? '',
          attachment.contentHash,
          1,
          true,
        ),
      ),
      ...articleBindings.map((binding) =>
        contextCandidate(binding.id, 'mention', binding.content, binding.revision, 1, true),
      ),
      ...evidenceRows.map((evidence) =>
        contextCandidate(
          `evidence:${evidence.id}`,
          'evidence',
          `${evidence.title}\n${evidence.excerpt}`,
          evidence.sourceRevision,
          1,
          true,
        ),
      ),
      ...(compaction?.summary && compaction.firstKeptMessageSequence
        ? [
            contextCandidate(
              `conversation-compaction:${compaction.id}`,
              'conversation',
              escapeUntrustedContext(
                JSON.stringify({
                  summary: compaction.summary,
                  protectedFactReferences: compaction.preserveData,
                }),
              ),
              String(compaction.version),
              1,
              true,
              false,
            ),
          ]
        : []),
      ...memoryHits.map(({ candidate: memory, score }) =>
        contextCandidate(
          memory.id,
          'memory',
          `${memory.subject}: ${memory.value}`,
          memory.valueHash,
          score,
          false,
        ),
      ),
    ];
    const pack = assembleContext({
      contextWindow: this.contextWindow,
      candidates,
      acceptedMemoryIds: new Set(memoryHits.map(({ candidate }) => candidate.id)),
      skillVersions: pinSkills(parsedSkills),
      retrievalVersion: 'accepted-memory.hybrid-v1',
      ...(compaction?.summary && compaction.firstKeptMessageSequence
        ? {
            conversationCompaction: {
              id: compaction.id,
              branchId: compaction.branchId,
              version: compaction.version,
              sourceFromSequence: compaction.sourceFromSequence,
              sourceThroughSequence: compaction.sourceThroughSequence,
              firstKeptMessageSequence: compaction.firstKeptMessageSequence,
              model: compaction.model,
              promptVersion: compaction.promptVersion,
            },
          }
        : {}),
    });
    const promptRevisionId = await this.persistPromptRevision(transaction);
    const pinnedArticles = new Map<
      string,
      { readonly revisionId: string; readonly contentHash: string }
    >();
    for (const binding of [
      ...mentionRows.map(({ id, revisionId, contentHash }) => ({
        articleId: id,
        revisionId,
        contentHash,
      })),
      ...articleBindings,
    ]) {
      const existing = pinnedArticles.get(binding.articleId);
      if (existing && existing.revisionId !== binding.revisionId) {
        throw new AgentApplicationError(
          'invalid_context',
          'One Run cannot bind multiple revisions of the same article',
        );
      }
      pinnedArticles.set(binding.articleId, {
        revisionId: binding.revisionId,
        contentHash: binding.contentHash,
      });
    }
    if (pinnedArticles.size > 0)
      await transaction.insert(mentionBindings).values(
        [...pinnedArticles].map(([articleId, binding]) => ({
          id: this.createId(),
          runId: input.runId,
          targetId: articleId,
          targetKind: 'article',
          revision: binding.revisionId,
          contentHash: binding.contentHash,
          authorizedUserId: input.userId,
        })),
      );
    if (selectedSkillRows.length > 0)
      await transaction.insert(runSkillBindings).values(
        selectedSkillRows.map((skill) => ({
          runId: input.runId,
          skillRevisionId: skill.id,
          contentHash: skill.contentHash,
          allowedTools: skill.allowedTools,
        })),
      );
    await transaction.insert(runContextPacks).values({
      id: this.createId(),
      runId: input.runId,
      promptRevisionId,
      manifest: pack.manifest,
      content: pack.content,
      contentHash: pack.contentHash,
      tokenCount: pack.manifest.tokenCount,
    });
    return pack;
  }

  public async load(runId: string): Promise<ContextPack | undefined> {
    const rows = await this.database
      .select({
        content: runContextPacks.content,
        contentHash: runContextPacks.contentHash,
        manifest: runContextPacks.manifest,
      })
      .from(runContextPacks)
      .where(eq(runContextPacks.runId, runId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          content: row.content,
          contentHash: row.contentHash,
          manifest: row.manifest as ContextPack['manifest'],
        }
      : undefined;
  }

  private async persistPromptRevision(transaction: DatabaseTransaction): Promise<string> {
    const id = this.createId();
    await transaction
      .insert(promptRevisions)
      .values({ id, ...this.prompt })
      .onConflictDoNothing();
    const rows = await transaction
      .select()
      .from(promptRevisions)
      .where(
        and(
          eq(promptRevisions.promptId, this.prompt.promptId),
          eq(promptRevisions.version, this.prompt.version),
        ),
      )
      .limit(1);
    const persisted = rows[0];
    if (persisted?.contentHash !== this.prompt.contentHash)
      throw new Error('Prompt revision identity is bound to different content');
    return persisted.id;
  }
}

function validateStoredSkill(row: typeof skillRevisions.$inferSelect): SkillDefinition {
  const skill = loadSkill(row.content);
  const contentHash = createPromptRevision('skill', 'integrity', row.content).contentHash;
  if (
    skill.id !== row.skillId ||
    skill.version !== row.version ||
    contentHash !== row.contentHash ||
    JSON.stringify(skill.allowedTools) !== JSON.stringify([...row.allowedTools].sort())
  )
    throw new Error(`Stored Skill ${row.skillId}@${row.version} failed integrity validation`);
  return skill;
}

function contextCandidate(
  id: string,
  kind: ContextCandidate['kind'],
  content: string,
  revision: string,
  score: number,
  required: boolean,
  trusted = true,
): ContextCandidate {
  return {
    id,
    kind,
    content,
    revision,
    tokenCount: Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4)),
    score,
    trusted,
    required,
  };
}

function escapeUntrustedContext(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueSkills(values: readonly SelectedSkillInput[]): readonly SelectedSkillInput[] {
  return [...new Map(values.map((skill) => [`${skill.skillId}@${skill.version}`, skill])).values()];
}

type ArticleContextBinding = Extract<
  RunContextBinding,
  { readonly type: 'article_revision' | 'article_selection' }
>;

function normalizeBindings(bindings: readonly RunContextBinding[]) {
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

async function loadBoundArticleContent(
  transaction: DatabaseTransaction,
  workspaceId: string,
  bindings: readonly ArticleContextBinding[],
): Promise<
  readonly {
    id: string;
    articleId: string;
    revisionId: string;
    contentHash: string;
    content: string;
    revision: string;
  }[]
> {
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

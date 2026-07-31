import { randomUUID } from 'node:crypto';

import {
  assembleContext,
  createPromptRevision,
  loadSkill,
  pinSkills,
  type ContextCandidate,
  type ContextPack,
  type SkillDefinition,
} from '@agentpress/agent-context';
import {
  articleRevisions,
  articles,
  type AgentPressDatabase,
  type DatabaseTransaction,
  memoryCandidates,
  mentionBindings,
  promptRevisions,
  runAttachments,
  runContextPacks,
  runSkillBindings,
  skillRevisions,
} from '@agentpress/database';
import { and, eq, inArray } from 'drizzle-orm';

import { AgentApplicationError, type SelectedSkillInput } from './contracts.js';

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
      readonly workspaceId: string;
      readonly userId: string;
      readonly mentionTargetIds: readonly string[];
      readonly attachmentIds: readonly string[];
      readonly skills: readonly SelectedSkillInput[];
    },
  ): Promise<ContextPack> {
    const mentions = unique(input.mentionTargetIds);
    const attachmentIds = unique(input.attachmentIds);
    const selectedSkills = uniqueSkills(input.skills);
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
    const memories = await transaction
      .select()
      .from(memoryCandidates)
      .where(
        and(
          eq(memoryCandidates.workspaceId, input.workspaceId),
          eq(memoryCandidates.userId, input.userId),
          eq(memoryCandidates.status, 'accepted'),
        ),
      )
      .limit(50);
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
          true,
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
      ...memories.map((memory) =>
        contextCandidate(
          memory.id,
          'memory',
          `${memory.subject}: ${memory.value}`,
          memory.valueHash,
          memory.confidenceBps / 10_000,
          false,
        ),
      ),
    ];
    const pack = assembleContext({
      contextWindow: this.contextWindow,
      candidates,
      acceptedMemoryIds: new Set(memories.map(({ id }) => id)),
      skillVersions: pinSkills(parsedSkills),
    });
    const promptRevisionId = await this.persistPromptRevision(transaction);
    if (mentionRows.length > 0)
      await transaction.insert(mentionBindings).values(
        mentionRows.map((mention) => ({
          id: this.createId(),
          runId: input.runId,
          targetId: mention.id,
          targetKind: 'article',
          revision: mention.revisionId,
          contentHash: mention.contentHash,
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
): ContextCandidate {
  return {
    id,
    kind,
    content,
    revision,
    tokenCount: Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4)),
    score,
    trusted: true,
    required,
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueSkills(values: readonly SelectedSkillInput[]): readonly SelectedSkillInput[] {
  return [...new Map(values.map((skill) => [`${skill.skillId}@${skill.version}`, skill])).values()];
}

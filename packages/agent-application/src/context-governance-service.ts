import { createHash, randomUUID } from 'node:crypto';

import {
  hashSkillRevisionContent,
  loadSkill,
  loadStaticSkillResources,
  type SkillResourceDocument,
} from '@agentpress/agent-context';
import {
  agentRuns,
  type AgentPressDatabase,
  decideMemoryCandidate,
  deleteMemoryCandidate,
  exportMemoryCandidates,
  memoryCandidates,
  proposeMemoryCandidate,
  rootRequests,
  skillRevisionResources,
  skillRevisions,
} from '@agentpress/database';
import type { ToolRegistry } from '@agentpress/tool-runtime';
import { Type } from '@sinclair/typebox';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { AgentApplicationError } from './contracts.js';

export class ContextGovernanceService {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly createId: () => string = randomUUID,
  ) {}

  public async createSkill(
    workspaceId: string,
    markdown: string,
    resourceDocuments: readonly SkillResourceDocument[] = [],
  ) {
    const skill = loadSkill(markdown);
    const resources = loadStaticSkillResources(skill, resourceDocuments);
    const contentHash = hashSkillRevisionContent(markdown, resources);
    const inserted = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .insert(skillRevisions)
        .values({
          id: this.createId(),
          workspaceId,
          skillId: skill.id,
          version: skill.version,
          content: markdown,
          contentHash,
          allowedTools: skill.allowedTools,
        })
        .onConflictDoNothing()
        .returning();
      const revision = rows[0];
      if (revision && resources.length > 0) {
        await transaction.insert(skillRevisionResources).values(
          resources.map((resource) => ({
            skillRevisionId: revision.id,
            path: resource.path,
            content: resource.content,
            contentHash: resource.contentHash,
            byteSize: Buffer.byteLength(resource.content, 'utf8'),
          })),
        );
      }
      return rows;
    });
    if (inserted[0]) return toPublicSkill(inserted[0], skill.description);
    const rows = await this.database
      .select()
      .from(skillRevisions)
      .where(
        and(
          eq(skillRevisions.workspaceId, workspaceId),
          eq(skillRevisions.skillId, skill.id),
          eq(skillRevisions.version, skill.version),
        ),
      )
      .limit(1);
    const existing = rows[0];
    if (existing?.contentHash !== contentHash)
      throw new AgentApplicationError(
        'invalid_context',
        `Skill ${skill.id}@${skill.version} already exists with different content`,
      );
    return toPublicSkill(existing, skill.description);
  }

  public async listSkills(workspaceId: string) {
    const rows = await this.database
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.workspaceId, workspaceId))
      .orderBy(skillRevisions.skillId, desc(skillRevisions.createdAt));
    return rows.map((row) => {
      try {
        const parsed = loadSkill(row.content);
        return toPublicSkill(
          row,
          parsed.description,
          parsed.disableModelInvocation === true ? 'policy_disabled' : 'available',
        );
      } catch {
        return toPublicSkill(row, '技能加载失败，无法绑定。', 'load_failed');
      }
    });
  }

  public listMemories(workspaceId: string, userId: string) {
    return this.database
      .select()
      .from(memoryCandidates)
      .where(
        and(eq(memoryCandidates.workspaceId, workspaceId), eq(memoryCandidates.userId, userId)),
      )
      .orderBy(desc(memoryCandidates.updatedAt))
      .limit(100);
  }

  public async decideMemory(
    workspaceId: string,
    userId: string,
    candidateId: string,
    decision: 'accepted' | 'rejected',
  ) {
    const result = await decideMemoryCandidate(this.database, {
      id: candidateId,
      workspaceId,
      userId,
      decision,
    });
    if (!result)
      throw new AgentApplicationError(
        'invalid_context',
        'Memory candidate is missing or no longer pending',
      );
    return result;
  }

  public async deleteMemory(workspaceId: string, userId: string, candidateId: string) {
    const deleted = await deleteMemoryCandidate(this.database, {
      id: candidateId,
      workspaceId,
      userId,
    });
    if (!deleted) {
      throw new AgentApplicationError(
        'invalid_context',
        'Memory candidate is missing, belongs to another user, or was already deleted',
      );
    }
    return { id: deleted.id, status: deleted.status };
  }

  public async exportMemories(workspaceId: string, userId: string) {
    const candidates = await exportMemoryCandidates(this.database, { workspaceId, userId });
    return {
      workspaceId,
      userId,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        subject: candidate.subject,
        value: candidate.value,
        status: candidate.status,
        kind: candidate.kind,
        confidenceBps: candidate.confidenceBps,
        importanceBps: candidate.importanceBps,
        validFrom: candidate.validFrom?.toISOString() ?? null,
        validUntil: candidate.validUntil?.toISOString() ?? null,
        sourceEvidenceIds: candidate.sourceEvidenceIds,
        sourceMemoryIds: candidate.sourceMemoryIds,
        supersedesId: candidate.supersedesId,
        createdAt: candidate.createdAt.toISOString(),
        updatedAt: candidate.updatedAt.toISOString(),
      })),
    };
  }

  public async proposeMemoryForRun(
    runId: string,
    subject: string,
    value: string,
    confidence: number,
  ) {
    const identityRows = await this.database
      .select({ workspaceId: agentRuns.workspaceId, userId: rootRequests.requestedByUserId })
      .from(agentRuns)
      .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const identity = identityRows[0];
    if (!identity?.userId)
      throw new AgentApplicationError('run_not_found', 'Run has no requesting user');
    const normalizedSubject = subject.trim();
    const normalizedValue = value.trim();
    if (!normalizedSubject || !normalizedValue)
      throw new AgentApplicationError('invalid_context', 'Memory subject and value are required');
    const valueHash = createHash('sha256').update(normalizedValue).digest('hex');
    const activeRows = await this.database
      .select({ id: memoryCandidates.id })
      .from(memoryCandidates)
      .where(
        and(
          eq(memoryCandidates.workspaceId, identity.workspaceId),
          eq(memoryCandidates.userId, identity.userId),
          eq(memoryCandidates.subject, normalizedSubject),
          eq(memoryCandidates.status, 'accepted'),
        ),
      )
      .orderBy(desc(memoryCandidates.updatedAt))
      .limit(1);
    const candidate = await proposeMemoryCandidate(this.database, {
      id: this.createId(),
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      subject: normalizedSubject,
      value: normalizedValue,
      valueHash,
      confidenceBps: Math.round(confidence * 10_000),
      ...(activeRows[0] ? { supersedesId: activeRows[0].id } : {}),
    });
    return {
      id: candidate.id,
      status: candidate.status,
      subject: candidate.subject,
      value: candidate.value,
      confidenceBps: candidate.confidenceBps,
      ...(candidate.supersedesId ? { supersedesId: candidate.supersedesId } : {}),
    };
  }

  public async proposeMemoryConsolidation(
    workspaceId: string,
    userId: string,
    input: {
      readonly sourceCandidateIds: readonly string[];
      readonly subject: string;
      readonly value: string;
      readonly confidence: number;
    },
  ) {
    const sourceIds = [...new Set(input.sourceCandidateIds)];
    if (sourceIds.length < 2 || sourceIds.length > 20)
      throw new AgentApplicationError(
        'invalid_context',
        'Memory consolidation requires between 2 and 20 unique sources',
      );
    const subject = input.subject.trim();
    const value = input.value.trim();
    if (!subject || !value)
      throw new AgentApplicationError('invalid_context', 'Memory subject and value are required');
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
      throw new AgentApplicationError(
        'invalid_context',
        'Memory confidence must be between 0 and 1',
      );

    return this.database.transaction(async (transaction) => {
      const sources = await transaction
        .select()
        .from(memoryCandidates)
        .where(
          and(
            eq(memoryCandidates.workspaceId, workspaceId),
            eq(memoryCandidates.userId, userId),
            eq(memoryCandidates.status, 'accepted'),
            inArray(memoryCandidates.id, sourceIds),
          ),
        )
        .for('update');
      if (sources.length !== sourceIds.length)
        throw new AgentApplicationError(
          'invalid_context',
          'Every consolidation source must be an accepted memory owned by the current user',
        );
      const latest = [...sources].sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
      )[0];
      if (!latest)
        throw new AgentApplicationError('invalid_context', 'Memory consolidation has no sources');
      const sourceEvidenceIds = [...new Set(sources.flatMap((source) => source.sourceEvidenceIds))];
      const kinds = new Set(sources.map(({ kind }) => kind));
      const candidate = await proposeMemoryCandidate(transaction, {
        id: this.createId(),
        workspaceId,
        userId,
        subject,
        value,
        valueHash: createHash('sha256').update(value).digest('hex'),
        confidenceBps: Math.round(input.confidence * 10_000),
        kind: kinds.size === 1 ? latest.kind : 'fact',
        importanceBps: Math.max(...sources.map(({ importanceBps }) => importanceBps)),
        sourceEvidenceIds,
        sourceMemoryIds: sourceIds,
        supersedesId: latest.id,
      });
      return {
        id: candidate.id,
        status: candidate.status,
        subject: candidate.subject,
        value: candidate.value,
        confidenceBps: candidate.confidenceBps,
        kind: candidate.kind,
        importanceBps: candidate.importanceBps,
        sourceEvidenceIds: candidate.sourceEvidenceIds,
        sourceMemoryIds: candidate.sourceMemoryIds,
        supersedesId: candidate.supersedesId,
      };
    });
  }
}

const memoryCandidateOutputSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    status: Type.Union(
      ['pending', 'accepted', 'rejected', 'superseded', 'deleted'].map((status) =>
        Type.Literal(status),
      ),
    ),
    subject: Type.String({ minLength: 1, maxLength: 200 }),
    value: Type.String({ minLength: 1, maxLength: 10_000 }),
    confidenceBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
    supersedesId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { additionalProperties: false },
);

export function registerContextTools(
  registry: ToolRegistry,
  service: ContextGovernanceService,
): void {
  registry.register({
    toolId: 'memory.propose',
    version: '1.0.0',
    owner: 'agentpress.context',
    description:
      'Propose a durable user memory candidate. New candidates require explicit acceptance; idempotent repeats may return an existing status.',
    capabilities: ['memory.propose'],
    inputSchema: Type.Object(
      {
        subject: Type.String({ minLength: 1, maxLength: 200 }),
        value: Type.String({ minLength: 1, maxLength: 10_000 }),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
    outputSchema: memoryCandidateOutputSchema,
    risk: 'draft_write',
    sideEffect:
      'Creates a pending memory candidate or returns an existing identical candidate without changing its status',
    idempotency: 'provider_key',
    timeoutMs: 5_000,
    estimateCost: () => ({}),
    execute: ({ subject, value, confidence }, context) =>
      service.proposeMemoryForRun(context.runId, subject, value, confidence),
  });
}

function toPublicSkill(
  row: typeof skillRevisions.$inferSelect,
  description: string,
  status: 'available' | 'policy_disabled' | 'load_failed' = 'available',
) {
  return {
    id: row.id,
    skillId: row.skillId,
    version: row.version,
    description,
    allowedTools: row.allowedTools,
    contentHash: row.contentHash,
    status,
    createdAt: row.createdAt.toISOString(),
  };
}

import { createHash, randomUUID } from 'node:crypto';

import {
  loadSkill,
  loadStaticSkillResources,
  type SkillResourceDocument,
} from '@agentpress/agent-context';
import {
  agentRuns,
  type AgentPressDatabase,
  decideMemoryCandidate,
  memoryCandidates,
  proposeMemoryCandidate,
  rootRequests,
  skillRevisionResources,
  skillRevisions,
} from '@agentpress/database';
import type { ToolRegistry } from '@agentpress/tool-runtime';
import { Type } from '@sinclair/typebox';
import { and, desc, eq } from 'drizzle-orm';

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
    const contentHash = createHash('sha256')
      .update(resources.length === 0 ? markdown : JSON.stringify({ markdown, resources }))
      .digest('hex');
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
      const parsed = loadSkill(row.content);
      return toPublicSkill(row, parsed.description);
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
    return proposeMemoryCandidate(this.database, {
      id: this.createId(),
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      subject: normalizedSubject,
      value: normalizedValue,
      valueHash,
      confidenceBps: Math.round(confidence * 10_000),
      ...(activeRows[0] ? { supersedesId: activeRows[0].id } : {}),
    });
  }
}

export function registerContextTools(
  registry: ToolRegistry,
  service: ContextGovernanceService,
): void {
  registry.register({
    toolId: 'memory.propose',
    version: '1.0.0',
    owner: 'agentpress.context',
    description:
      'Propose a durable user memory candidate. The user must explicitly accept it before retrieval.',
    capabilities: ['memory.propose'],
    inputSchema: Type.Object(
      {
        subject: Type.String({ minLength: 1, maxLength: 200 }),
        value: Type.String({ minLength: 1, maxLength: 10_000 }),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Any(),
    risk: 'draft_write',
    sideEffect: 'Creates a pending memory candidate; it is not recalled until the user accepts it',
    idempotency: 'provider_key',
    timeoutMs: 5_000,
    estimateCost: () => ({}),
    execute: ({ subject, value, confidence }, context) =>
      service.proposeMemoryForRun(context.runId, subject, value, confidence),
  });
}

function toPublicSkill(row: typeof skillRevisions.$inferSelect, description: string) {
  return {
    id: row.id,
    skillId: row.skillId,
    version: row.version,
    description,
    allowedTools: row.allowedTools,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
  };
}

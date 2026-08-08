import type { ArticleDocument } from '@agentpress/editor-patch';
import {
  agentRuns,
  appendRunEvent,
  artifactEvidence,
  artifacts,
  artifactVersions,
  articleRevisions,
  articles,
  evidenceRecords,
  runEvents,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { RunEventPublisher } from './contracts.js';
import {
  reviewArticleDeterministically,
  type ArticleClaim,
  type ArticleReviewCandidate,
} from './article-review-policy.js';
import {
  recoverSettlement,
  type RecoveryGap,
  type RecoveryNextAction,
  type RecoveryPreservedFacts,
  type RecoveryValidationIssue,
} from './recovery-policy.js';
import { toDurableEvent } from './run-projection-service.js';

type RecoveryFactValidationServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly publisher: RunEventPublisher;
  readonly createId: () => string;
};

export type RecoveryFactValidationResult =
  | { readonly status: 'not_applicable' | 'already_validated' }
  | { readonly status: 'validated' }
  | {
      readonly status: 'completed_with_degradation';
      readonly preservedFacts: readonly RecoveryPreservedFacts[];
      readonly missingFacts: readonly RecoveryGap[];
      readonly unverified: readonly RecoveryGap[];
      readonly nextActions: readonly RecoveryNextAction[];
    };

/** Revalidates immutable recovery facts through their existing domain owners. */
export class RecoveryFactValidationService {
  public constructor(private readonly options: RecoveryFactValidationServiceOptions) {}

  public async validateAndProject(runId: string): Promise<RecoveryFactValidationResult> {
    const persisted = await this.options.database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from ${agentRuns} where id = ${runId} for update`);
      const runRows = await transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      if (runRows[0]?.status !== 'running') {
        return { result: { status: 'not_applicable' as const } };
      }
      const recoveryEvents = await transaction
        .select({ eventType: runEvents.eventType })
        .from(runEvents)
        .where(
          and(
            eq(runEvents.runId, runId),
            inArray(runEvents.eventType, [
              'run.recovering',
              'run.recovery.validated',
              'run.recovery.degraded',
            ]),
          ),
        );
      if (!recoveryEvents.some(({ eventType }) => eventType === 'run.recovering')) {
        return { result: { status: 'not_applicable' as const } };
      }
      if (
        recoveryEvents.some(
          ({ eventType }) =>
            eventType === 'run.recovery.validated' || eventType === 'run.recovery.degraded',
        )
      ) {
        return { result: { status: 'already_validated' as const } };
      }

      const draftRows = await transaction
        .select({
          artifactId: artifacts.id,
          artifactVersionId: artifactVersions.id,
          version: artifactVersions.version,
          summary: artifactVersions.summary,
          content: artifactVersions.content,
        })
        .from(artifacts)
        .innerJoin(
          artifactVersions,
          and(
            eq(artifactVersions.artifactId, artifacts.id),
            eq(artifactVersions.version, artifacts.currentVersion),
          ),
        )
        .where(and(eq(artifacts.runId, runId), eq(artifacts.type, 'ArticleDraft')));
      const versionIds = draftRows.map(({ artifactVersionId }) => artifactVersionId);
      const evidenceLinks =
        versionIds.length === 0
          ? []
          : await transaction
              .select({
                artifactVersionId: artifactEvidence.artifactVersionId,
                evidenceId: artifactEvidence.evidenceId,
                evidenceRunId: evidenceRecords.runId,
                sourceRevision: evidenceRecords.sourceRevision,
              })
              .from(artifactEvidence)
              .innerJoin(evidenceRecords, eq(evidenceRecords.id, artifactEvidence.evidenceId))
              .where(inArray(artifactEvidence.artifactVersionId, versionIds));
      const parsed = draftRows.map((row) => ({ row, parsed: parseCandidateContent(row.content) }));
      const baseRevisionIds = parsed.flatMap(({ parsed: candidate }) =>
        candidate ? [candidate.baseRevisionId] : [],
      );
      const revisionRows =
        baseRevisionIds.length === 0
          ? []
          : await transaction
              .select({
                baseRevisionId: articleRevisions.id,
                articleId: articleRevisions.articleId,
                currentRevisionId: articles.currentRevisionId,
              })
              .from(articleRevisions)
              .innerJoin(articles, eq(articles.id, articleRevisions.articleId))
              .where(inArray(articleRevisions.id, baseRevisionIds));
      const revisions = new Map(revisionRows.map((row) => [row.baseRevisionId, row]));
      const issues: RecoveryValidationIssue[] = [];
      const missingFacts: RecoveryGap[] = [];
      const preservedFacts: RecoveryPreservedFacts[] = [];

      for (const revision of revisionRows) {
        if (!revision.currentRevisionId) continue;
        preservedFacts.push({
          kind: 'article_revision',
          id: revision.currentRevisionId,
          revision: revision.currentRevisionId,
          description: `Current Article Revision ${revision.currentRevisionId}`,
        });
      }
      for (const link of evidenceLinks) {
        if (link.evidenceRunId !== runId) continue;
        preservedFacts.push({
          kind: 'evidence',
          id: link.evidenceId,
          revision: link.sourceRevision,
          description: `Evidence ${link.evidenceId}`,
        });
      }
      for (const entry of parsed) {
        const candidate = entry.parsed;
        if (!candidate) {
          issues.push({
            code: 'invalid_recovery_artifact',
            message: `Artifact Version ${entry.row.artifactVersionId} is not a valid ArticleDraft`,
          });
          missingFacts.push({
            code: 'article_draft_invalid',
            description: 'A valid recovered ArticleDraft is missing',
            reference: entry.row.artifactVersionId,
          });
          continue;
        }
        const revision = revisions.get(candidate.baseRevisionId);
        if (!revision?.currentRevisionId) {
          issues.push({
            code: 'article_revision_missing',
            message: `Article Revision ${candidate.baseRevisionId} is unavailable`,
          });
          missingFacts.push({
            code: 'article_revision_missing',
            description: 'The ArticleDraft base revision is unavailable',
            reference: candidate.baseRevisionId,
          });
          continue;
        }
        const links = evidenceLinks.filter(
          ({ artifactVersionId }) => artifactVersionId === entry.row.artifactVersionId,
        );
        const availableEvidenceIds = new Set(
          links.flatMap(({ evidenceId, evidenceRunId }) =>
            evidenceRunId === runId ? [evidenceId] : [],
          ),
        );
        const reviewCandidate: ArticleReviewCandidate = {
          artifactId: entry.row.artifactId,
          artifactVersionId: entry.row.artifactVersionId,
          version: entry.row.version,
          baseRevisionId: candidate.baseRevisionId,
          document: candidate.document,
          claims: candidate.claims,
          evidenceIds: [...availableEvidenceIds],
          summary: entry.row.summary,
        };
        const review = reviewArticleDeterministically(reviewCandidate, {
          currentRevisionId: revision.currentRevisionId,
          availableEvidenceIds,
          minCharacters: 1,
          maxCharacters: 100_000,
          maxBlocks: 2_000,
        });
        if (review.valid) {
          preservedFacts.push({
            kind: 'artifact_version',
            id: entry.row.artifactVersionId,
            revision: String(entry.row.version),
            description: `Validated ArticleDraft ${entry.row.artifactVersionId}`,
          });
        } else {
          issues.push(
            ...review.issues.map(({ code, message }) => ({
              code,
              message: `${entry.row.artifactVersionId}: ${message}`,
            })),
          );
          if (review.issues.some(({ code }) => code === 'missing_evidence')) {
            missingFacts.push({
              code: 'evidence_missing',
              description: 'The recovered ArticleDraft has unavailable Evidence',
              reference: entry.row.artifactVersionId,
            });
          }
        }
      }

      if (issues.length === 0) {
        const event = await appendRunEvent(transaction, {
          id: this.options.createId(),
          runId,
          eventType: 'run.recovery.validated',
          payload: { preservedFacts: uniqueFacts(preservedFacts) },
        });
        return {
          result: { status: 'validated' as const },
          event: toDurableEvent(event),
        };
      }
      const recovery = await recoverSettlement({
        candidate: { artifactVersionIds: versionIds },
        initialValidation: { valid: false, issues },
        replaySafe: false,
        preservedFacts: uniqueFacts(preservedFacts),
        missingFacts: uniqueGaps(missingFacts),
        nextActions: versionIds.map((targetId) => ({
          kind: 'regenerate_artifact' as const,
          labelKey: 'recovery.action.regenerate_artifact',
          targetId,
        })),
        settle: () => Promise.reject(new Error('Non-replay-safe recovery must not settle')),
        validate: () => Promise.reject(new Error('Non-replay-safe recovery must not validate')),
      });
      if (recovery.status !== 'completed_with_degradation') {
        throw new Error('Recovery fact validation produced an invalid terminal status');
      }
      const event = await appendRunEvent(transaction, {
        id: this.options.createId(),
        runId,
        eventType: 'run.recovery.degraded',
        payload: {
          preservedFacts: recovery.preservedFacts,
          missingFacts: recovery.missingFacts,
          unverified: recovery.unverified,
          nextActions: recovery.nextActions,
        },
      });
      return {
        result: {
          status: recovery.status,
          preservedFacts: recovery.preservedFacts,
          missingFacts: recovery.missingFacts,
          unverified: recovery.unverified,
          nextActions: recovery.nextActions,
        },
        event: toDurableEvent(event),
      };
    });
    if (persisted.event) {
      await this.options.publisher.publish({ durable: true, event: persisted.event });
    }
    return persisted.result;
  }
}

function parseCandidateContent(content: Readonly<Record<string, unknown>>):
  | {
      readonly baseRevisionId: string;
      readonly document: ArticleDocument;
      readonly claims: readonly ArticleClaim[];
    }
  | undefined {
  if (typeof content.baseRevisionId !== 'string' || !isArticleDocument(content.document)) {
    return undefined;
  }
  if (!Array.isArray(content.claims)) return undefined;
  const claims = content.claims.flatMap((value) => {
    if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.evidenceIds)) {
      return [];
    }
    const evidenceIds = value.evidenceIds.filter(
      (evidenceId): evidenceId is string => typeof evidenceId === 'string',
    );
    return evidenceIds.length === value.evidenceIds.length
      ? [{ text: value.text, evidenceIds }]
      : [];
  });
  return claims.length === content.claims.length
    ? { baseRevisionId: content.baseRevisionId, document: content.document, claims }
    : undefined;
}

function isArticleDocument(value: unknown): value is ArticleDocument {
  if (!isRecord(value) || value.type !== 'doc' || !Array.isArray(value.content)) return false;
  return value.content.every(
    (block) => isRecord(block) && isRecord(block.attrs) && Array.isArray(block.content),
  );
}

function uniqueFacts(facts: readonly RecoveryPreservedFacts[]): readonly RecoveryPreservedFacts[] {
  return [
    ...new Map(facts.map((fact) => [`${fact.kind}:${fact.id}:${fact.revision}`, fact])).values(),
  ];
}

function uniqueGaps(gaps: readonly RecoveryGap[]): readonly RecoveryGap[] {
  return [...new Map(gaps.map((gap) => [`${gap.code}:${gap.reference ?? ''}`, gap])).values()];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

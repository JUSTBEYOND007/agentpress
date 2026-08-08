import type { ArticleDocument } from '@agentpress/editor-patch';
import {
  agentTasks,
  artifactEvidence,
  artifacts,
  artifactVersions,
  articleRevisions,
  articles,
  evidenceRecords,
  taskResultInvalidations,
  taskResults,
  type DatabaseTransaction,
} from '@agentpress/database';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import {
  reviewArticleDeterministically,
  type ArticleClaim,
  type ArticleReviewCandidate,
} from './article-review-policy.js';
import type {
  RecoveryGap,
  RecoveryPreservedFacts,
  RecoveryValidationIssue,
} from './recovery-policy.js';

export type DamagedTaskResult = {
  readonly taskResultId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly artifactVersionIds: readonly string[];
  readonly issues: readonly RecoveryValidationIssue[];
};

export type RecoveryFactInspection = {
  readonly artifactVersionIds: readonly string[];
  readonly issues: readonly RecoveryValidationIssue[];
  readonly missingFacts: readonly RecoveryGap[];
  readonly preservedFacts: readonly RecoveryPreservedFacts[];
  readonly damagedTaskResults: readonly DamagedTaskResult[];
};

type ActiveTaskResult = {
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly owner: string;
  readonly artifacts: readonly unknown[];
};

export async function inspectRecoveryFacts(
  transaction: DatabaseTransaction,
  runId: string,
): Promise<RecoveryFactInspection> {
  const allDraftRows = await transaction
    .select({
      artifactId: artifacts.id,
      taskId: artifacts.taskId,
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
  const resultRows = await transaction
    .select({
      id: taskResults.id,
      taskId: taskResults.taskId,
      attempt: taskResults.attempt,
      artifacts: taskResults.artifacts,
      owner: agentTasks.owner,
      maxAttempts: agentTasks.maxAttempts,
    })
    .from(taskResults)
    .innerJoin(agentTasks, eq(agentTasks.id, taskResults.taskId))
    .leftJoin(taskResultInvalidations, eq(taskResultInvalidations.taskResultId, taskResults.id))
    .where(
      and(
        eq(agentTasks.runId, runId),
        eq(taskResults.status, 'succeeded'),
        isNull(taskResultInvalidations.id),
      ),
    )
    .orderBy(desc(taskResults.attempt));
  const activeResults = latestResults(resultRows);
  const references = new Map(
    [...activeResults.values()].map((result) => [
      result.taskId,
      artifactReferences(result.artifacts),
    ]),
  );
  const draftRows = allDraftRows.filter(
    (row) =>
      row.taskId === null ||
      (references.get(row.taskId)?.has(row.artifactId) ?? false) ||
      (references.get(row.taskId)?.has(row.artifactVersionId) ?? false),
  );
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
  const baseRevisionIds = unique(
    parsed.flatMap(({ parsed: candidate }) => (candidate ? [candidate.baseRevisionId] : [])),
  );
  const revisionRows =
    baseRevisionIds.length === 0
      ? []
      : await transaction
          .select({
            baseRevisionId: articleRevisions.id,
            currentRevisionId: articles.currentRevisionId,
          })
          .from(articleRevisions)
          .innerJoin(articles, eq(articles.id, articleRevisions.articleId))
          .where(inArray(articleRevisions.id, baseRevisionIds));
  const revisions = new Map(revisionRows.map((row) => [row.baseRevisionId, row]));
  const issues: RecoveryValidationIssue[] = [];
  const missingFacts: RecoveryGap[] = [];
  const preservedFacts: RecoveryPreservedFacts[] = [];
  const damaged = new Map<string, DamagedTaskResult>();

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
    const result = entry.row.taskId ? activeResults.get(entry.row.taskId) : undefined;
    const candidateIssues: RecoveryValidationIssue[] = [];
    const candidate = entry.parsed;
    if (result && result.owner !== 'writer') {
      candidateIssues.push({
        code: 'artifact_owner_invalid',
        message: `Task ${result.taskId} owner cannot produce an ArticleDraft`,
      });
    }
    if (!candidate) {
      candidateIssues.push({
        code: 'invalid_recovery_artifact',
        message: `Artifact Version ${entry.row.artifactVersionId} is not a valid ArticleDraft`,
      });
      missingFacts.push({
        code: 'article_draft_invalid',
        description: 'A valid recovered ArticleDraft is missing',
        reference: entry.row.artifactVersionId,
      });
    } else {
      const revision = revisions.get(candidate.baseRevisionId);
      if (!revision?.currentRevisionId) {
        candidateIssues.push({
          code: 'article_revision_missing',
          message: `Article Revision ${candidate.baseRevisionId} is unavailable`,
        });
        missingFacts.push({
          code: 'article_revision_missing',
          description: 'The ArticleDraft base revision is unavailable',
          reference: candidate.baseRevisionId,
        });
      } else {
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
        candidateIssues.push(
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
    if (candidateIssues.length === 0) {
      preservedFacts.push({
        kind: 'artifact_version',
        id: entry.row.artifactVersionId,
        revision: String(entry.row.version),
        description: `Validated ArticleDraft ${entry.row.artifactVersionId}`,
      });
      continue;
    }
    issues.push(...candidateIssues);
    if (result) addDamagedResult(damaged, result, entry.row.artifactVersionId, candidateIssues);
  }
  for (const result of activeResults.values()) {
    for (const reference of articleDraftReferences(result.artifacts)) {
      if (
        draftRows.some(
          ({ artifactId, artifactVersionId }) =>
            artifactId === reference.artifactId || artifactVersionId === reference.versionId,
        )
      ) {
        continue;
      }
      const issue = {
        code: 'artifact_version_missing',
        message: `TaskResult ${result.id} references a missing ArticleDraft`,
      };
      issues.push(issue);
      const referenceId = reference.versionId ?? reference.artifactId;
      if (!referenceId) continue;
      missingFacts.push({
        code: issue.code,
        description: issue.message,
        reference: referenceId,
      });
      addDamagedResult(damaged, result, referenceId, [issue]);
    }
  }
  return {
    artifactVersionIds: versionIds,
    issues,
    missingFacts: uniqueGaps(missingFacts),
    preservedFacts: uniqueFacts(preservedFacts),
    damagedTaskResults: [...damaged.values()],
  };
}

function latestResults(rows: readonly ActiveTaskResult[]): ReadonlyMap<string, ActiveTaskResult> {
  const results = new Map<string, ActiveTaskResult>();
  for (const row of rows) if (!results.has(row.taskId)) results.set(row.taskId, row);
  return results;
}

function artifactReferences(value: readonly unknown[]): ReadonlySet<string> {
  return new Set(
    value.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      return [candidate.artifactId, candidate.versionId].filter(
        (reference): reference is string => typeof reference === 'string',
      );
    }),
  );
}

function articleDraftReferences(
  value: readonly unknown[],
): readonly { readonly artifactId?: string; readonly versionId?: string }[] {
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || candidate.type !== 'ArticleDraft') return [];
    const artifactId = typeof candidate.artifactId === 'string' ? candidate.artifactId : undefined;
    const versionId = typeof candidate.versionId === 'string' ? candidate.versionId : undefined;
    return artifactId || versionId
      ? [{ ...(artifactId ? { artifactId } : {}), ...(versionId ? { versionId } : {}) }]
      : [];
  });
}

function addDamagedResult(
  damaged: Map<string, DamagedTaskResult>,
  result: ActiveTaskResult,
  artifactVersionId: string,
  issues: readonly RecoveryValidationIssue[],
): void {
  const existing = damaged.get(result.id);
  damaged.set(result.id, {
    taskResultId: result.id,
    taskId: result.taskId,
    attempt: result.attempt,
    maxAttempts: result.maxAttempts,
    artifactVersionIds: unique([...(existing?.artifactVersionIds ?? []), artifactVersionId]),
    issues: [...(existing?.issues ?? []), ...issues],
  });
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

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import {
  artifacts,
  artifactEvidence,
  artifactVersions,
  type AgentPressDatabase,
  evidenceRecords,
} from '@agentpress/database';
import { and, asc, eq } from 'drizzle-orm';

export type ArtifactLookupResult =
  | { readonly status: 'found'; readonly artifact: Readonly<Record<string, unknown>> }
  | { readonly status: 'not_found' }
  | { readonly status: 'stale'; readonly currentVersion: number };

export class ArtifactQueryService {
  public constructor(private readonly database: AgentPressDatabase) {}

  public async get(
    runId: string,
    artifactId: string,
    expectedVersion?: number,
  ): Promise<ArtifactLookupResult> {
    const rows = await this.database
      .select({
        id: artifacts.id,
        type: artifacts.type,
        title: artifacts.title,
        currentVersion: artifacts.currentVersion,
      })
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.runId, runId)))
      .limit(1);
    const artifact = rows[0];
    if (!artifact) return { status: 'not_found' };
    if (expectedVersion !== undefined && artifact.currentVersion !== expectedVersion) {
      return { status: 'stale', currentVersion: artifact.currentVersion };
    }

    const [versionRows, evidenceRows] = await Promise.all([
      this.database
        .select({
          version: artifactVersions.version,
          summary: artifactVersions.summary,
          content: artifactVersions.content,
        })
        .from(artifactVersions)
        .where(
          and(
            eq(artifactVersions.artifactId, artifact.id),
            eq(artifactVersions.version, artifact.currentVersion),
          ),
        )
        .limit(1),
      this.database
        .select({
          evidenceId: artifactEvidence.evidenceId,
          claim: artifactEvidence.claim,
          ordinal: artifactEvidence.ordinal,
          title: evidenceRecords.title,
          source: evidenceRecords.sourceUri,
        })
        .from(artifactEvidence)
        .innerJoin(artifactVersions, eq(artifactVersions.id, artifactEvidence.artifactVersionId))
        .innerJoin(evidenceRecords, eq(evidenceRecords.id, artifactEvidence.evidenceId))
        .where(
          and(
            eq(artifactVersions.artifactId, artifact.id),
            eq(artifactVersions.version, artifact.currentVersion),
          ),
        )
        .orderBy(asc(artifactEvidence.ordinal)),
    ]);
    const version = versionRows[0];
    if (!version) return { status: 'not_found' };
    return {
      status: 'found',
      artifact: { ...artifact, ...version, evidence: evidenceRows },
    };
  }
}

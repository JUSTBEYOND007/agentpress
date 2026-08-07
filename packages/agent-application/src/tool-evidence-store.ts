import { createHash, randomUUID } from 'node:crypto';

import {
  artifacts,
  artifactVersions,
  evidenceRecords,
  type AgentPressDatabase,
  type DatabaseTransaction,
} from '@agentpress/database';
import { and, eq, isNull } from 'drizzle-orm';

type ToolEvidenceStoreOptions = {
  readonly database: AgentPressDatabase;
};

export type PersistToolEvidenceInput = {
  readonly runId: string;
  readonly taskId?: string;
  readonly toolCallId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly output: unknown;
};

export type PersistedToolEvidence = {
  readonly evidenceId: string;
  readonly title: string;
  readonly source: string;
  readonly sourceRevision: string;
};

/** Projects inline or artifact-backed Tool output into idempotent Evidence facts. */
export class ToolEvidenceStore {
  public constructor(private readonly options: ToolEvidenceStoreOptions) {}

  public async persist(input: PersistToolEvidenceInput): Promise<readonly PersistedToolEvidence[]> {
    return this.options.database.transaction((transaction) =>
      this.persistInTransaction(transaction, input),
    );
  }

  public async persistInTransaction(
    transaction: DatabaseTransaction,
    input: PersistToolEvidenceInput,
  ): Promise<readonly PersistedToolEvidence[]> {
    const sourceOutput = await this.resolveSourceOutput(transaction, input);
    const extracted = extractToolEvidence(sourceOutput);
    if (extracted.length === 0) return [];
    const records = extracted.map((item) => ({
      id: randomUUID(),
      runId: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      sourceToolCallId: input.toolCallId,
      sourceType: 'tool',
      sourceUri: item.sourceUri,
      title: item.title,
      excerpt: item.excerpt,
      sourceRevision: item.sourceRevision,
      contentHash: createHash('sha256').update(item.excerpt).digest('hex'),
      metadata: {
        toolCallId: input.toolCallId,
        toolId: input.toolId,
        toolVersion: input.toolVersion,
      },
    }));
    await transaction
      .insert(evidenceRecords)
      .values(records)
      .onConflictDoNothing({
        target: [
          evidenceRecords.sourceToolCallId,
          evidenceRecords.sourceUri,
          evidenceRecords.contentHash,
        ],
      });
    const durable = await transaction
      .select({
        id: evidenceRecords.id,
        title: evidenceRecords.title,
        sourceUri: evidenceRecords.sourceUri,
        sourceRevision: evidenceRecords.sourceRevision,
      })
      .from(evidenceRecords)
      .where(eq(evidenceRecords.sourceToolCallId, input.toolCallId))
      .orderBy(evidenceRecords.createdAt, evidenceRecords.id);
    return durable.map(({ id, title, sourceUri, sourceRevision }) => ({
      evidenceId: id,
      title,
      source: sourceUri ?? '',
      sourceRevision,
    }));
  }

  public async listForToolCall(toolCallId: string): Promise<readonly PersistedToolEvidence[]> {
    const rows = await this.options.database
      .select({
        id: evidenceRecords.id,
        title: evidenceRecords.title,
        sourceUri: evidenceRecords.sourceUri,
        sourceRevision: evidenceRecords.sourceRevision,
      })
      .from(evidenceRecords)
      .where(eq(evidenceRecords.sourceToolCallId, toolCallId))
      .orderBy(evidenceRecords.createdAt, evidenceRecords.id);
    return rows.map(({ id, title, sourceUri, sourceRevision }) => ({
      evidenceId: id,
      title,
      source: sourceUri ?? '',
      sourceRevision,
    }));
  }

  private async resolveSourceOutput(
    transaction: DatabaseTransaction,
    input: PersistToolEvidenceInput,
  ): Promise<unknown> {
    if (extractToolEvidence(input.output).length > 0) return input.output;
    const artifactId = outputArtifactId(input.output);
    if (!artifactId) return input.output;
    const rows = await transaction
      .select({ content: artifactVersions.content })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(
        and(
          eq(artifacts.id, artifactId),
          eq(artifacts.runId, input.runId),
          eq(artifacts.type, 'ToolOutput'),
          input.taskId ? eq(artifacts.taskId, input.taskId) : isNull(artifacts.taskId),
        ),
      )
      .limit(1);
    const content = recordValue(rows[0]?.content);
    return content.toolCallId === input.toolCallId ? content.output : input.output;
  }
}

function outputArtifactId(output: unknown): string | undefined {
  const root = recordValue(output);
  const value = recordValue(root.value);
  return typeof value.artifactId === 'string' ? value.artifactId : undefined;
}

type ToolEvidence = {
  readonly sourceUri: string;
  readonly title: string;
  readonly excerpt: string;
  readonly sourceRevision: string;
};

function extractToolEvidence(output: unknown): readonly ToolEvidence[] {
  const root = recordValue(output);
  const candidates = Array.isArray(root.value)
    ? root.value
    : Array.isArray(root.results)
      ? root.results
      : Array.isArray(output)
        ? output
        : [];
  return candidates.flatMap((candidate) => {
    const item = recordValue(candidate);
    const sourceUri = firstString(item.url, item.pageUrl, item.uri, item.source);
    const excerpt = firstString(item.excerpt, item.text, item.content, item.snippet);
    if (!sourceUri || !excerpt) return [];
    return [
      {
        sourceUri,
        title: firstString(item.title, excerpt.slice(0, 160), sourceUri),
        excerpt: excerpt.slice(0, 20_000),
        sourceRevision: firstString(
          item.revisionHash,
          item.contentHash,
          item.updatedAt,
          createHash('sha256').update(excerpt).digest('hex'),
        ),
      },
    ];
  });
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function firstString(...values: readonly unknown[]): string {
  return (
    values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? ''
  );
}

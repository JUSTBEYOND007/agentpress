import { randomUUID } from 'node:crypto';
import { applyAutosaveSteps, hashDocument, type ArticleDocument } from '@agentpress/editor-patch';
import {
  articleDrafts,
  articleRevisions,
  autosaveBatches,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, eq } from 'drizzle-orm';
import type { AutosaveAck, AutosaveBatch, WriterLease } from './contracts.js';
import { EditorApplicationError } from './contracts.js';

export class AutosaveService {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly lease: WriterLease,
    private readonly createId: () => string = randomUUID,
  ) {}
  public async save(input: AutosaveBatch): Promise<AutosaveAck> {
    if (
      !input.updateId ||
      input.steps.length < 1 ||
      input.steps.length > 200 ||
      input.schemaVersion < 1
    )
      throw new EditorApplicationError('invalid_batch', 'Autosave batch is invalid');
    if (!(await this.lease.owns(input.articleId, input.userId, input.writerLeaseId)))
      throw new EditorApplicationError(
        'lease_lost',
        'Writer lease is no longer owned by this client',
      );
    return this.database.transaction(async (transaction) => {
      const duplicate = await transaction
        .select()
        .from(autosaveBatches)
        .where(eq(autosaveBatches.updateId, input.updateId))
        .limit(1);
      if (duplicate[0]) {
        const draft = await findDraft(transaction, input.articleId, input.userId);
        if (!draft)
          throw new EditorApplicationError(
            'draft_not_found',
            'Acknowledged draft no longer exists',
          );
        return ack(input, draft, true);
      }
      const draft = await findDraft(transaction, input.articleId, input.userId, true);
      let document: unknown;
      const draftId = draft?.id ?? this.createId();
      const sequence = (draft?.serverSequence ?? 0) + 1;
      if (draft) {
        if (draft.baseRevisionId !== input.baseRevisionId)
          throw new EditorApplicationError('base_revision_mismatch', 'Draft base revision changed');
        document = draft.document;
      } else {
        const revisions = await transaction
          .select()
          .from(articleRevisions)
          .where(
            and(
              eq(articleRevisions.id, input.baseRevisionId),
              eq(articleRevisions.articleId, input.articleId),
            ),
          )
          .limit(1);
        const revision = revisions[0];
        if (!revision)
          throw new EditorApplicationError(
            'article_not_found',
            'Article base revision does not exist',
          );
        document = revision.document;
      }
      const nextDocument = applyAutosaveSteps(document, input.steps) as ArticleDocument;
      const documentHash = hashDocument(nextDocument);
      if (draft)
        await transaction
          .update(articleDrafts)
          .set({
            writerLeaseId: input.writerLeaseId,
            schemaVersion: input.schemaVersion,
            document: nextDocument,
            documentHash,
            serverSequence: sequence,
            updatedAt: new Date(),
          })
          .where(eq(articleDrafts.id, draft.id));
      else
        await transaction.insert(articleDrafts).values({
          id: draftId,
          articleId: input.articleId,
          userId: input.userId,
          writerLeaseId: input.writerLeaseId,
          baseRevisionId: input.baseRevisionId,
          schemaVersion: input.schemaVersion,
          document: nextDocument,
          documentHash,
          serverSequence: sequence,
        });
      await transaction.insert(autosaveBatches).values({
        id: this.createId(),
        updateId: input.updateId,
        articleId: input.articleId,
        userId: input.userId,
        writerLeaseId: input.writerLeaseId,
        baseRevisionId: input.baseRevisionId,
        schemaVersion: input.schemaVersion,
        steps: input.steps,
        resultingDraftSequence: sequence,
      });
      return {
        updateId: input.updateId,
        articleId: input.articleId,
        draftId,
        serverSequence: sequence,
        documentHash,
        duplicate: false,
      };
    });
  }
  public async recover(articleId: string, userId: string) {
    return findDraft(this.database, articleId, userId);
  }
}

type QueryDatabase = Pick<AgentPressDatabase, 'select'>;
async function findDraft(database: QueryDatabase, articleId: string, userId: string, lock = false) {
  const query = database
    .select()
    .from(articleDrafts)
    .where(and(eq(articleDrafts.articleId, articleId), eq(articleDrafts.userId, userId)))
    .limit(1);
  const rows = lock && 'for' in query ? await query.for('update') : await query;
  return rows[0];
}
function ack(
  input: AutosaveBatch,
  draft: typeof articleDrafts.$inferSelect,
  duplicate: boolean,
): AutosaveAck {
  return {
    updateId: input.updateId,
    articleId: input.articleId,
    draftId: draft.id,
    serverSequence: draft.serverSequence,
    documentHash: draft.documentHash,
    duplicate,
  };
}

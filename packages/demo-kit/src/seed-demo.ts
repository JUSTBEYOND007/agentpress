import { createHash } from 'node:crypto';

import {
  appUsers,
  articleRevisions,
  articles,
  conversationBranches,
  conversations,
  publications,
  workspaceMembers,
  workspaces,
  type AgentPressDatabase,
} from '@agentpress/database';
import { PublicationService } from '@agentpress/publication-application';
import { and, eq, isNull } from 'drizzle-orm';

export const DEMO_IDS = {
  user: '00000000-0000-4000-8000-000000000001',
  workspace: '00000000-0000-4000-8000-000000000002',
  article: '00000000-0000-4000-8000-000000000003',
  revision: '00000000-0000-4000-8000-000000000004',
  conversation: '00000000-0000-4000-8000-000000000005',
  branch: '00000000-0000-4000-8000-000000000006',
} as const;

const DEMO_SLUG = 'agent-era-long-form-writing';
const document = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1, blockId: 'title' },
      content: [{ type: 'text', text: 'Agent 时代的长文创作' }],
    },
    {
      type: 'paragraph',
      attrs: { blockId: 'lead' },
      content: [{ type: 'text', text: '让研究、组织、修改和核验都变得可见、可控。' }],
    },
  ],
} as const;

export async function seedDemo(database: AgentPressDatabase): Promise<typeof DEMO_IDS> {
  await database.transaction(async (transaction) => {
    await transaction
      .insert(appUsers)
      .values({
        id: DEMO_IDS.user,
        logtoSubject: 'demo|agentpress',
        displayName: 'AgentPress Demo',
      })
      .onConflictDoNothing();
    await transaction
      .insert(workspaces)
      .values({ id: DEMO_IDS.workspace, name: 'AgentPress Demo' })
      .onConflictDoNothing();
    await transaction
      .insert(workspaceMembers)
      .values({ workspaceId: DEMO_IDS.workspace, userId: DEMO_IDS.user, role: 'owner' })
      .onConflictDoNothing();
    await transaction
      .insert(articles)
      .values({
        id: DEMO_IDS.article,
        workspaceId: DEMO_IDS.workspace,
        title: 'Agent 时代的长文创作',
      })
      .onConflictDoNothing();
    await transaction
      .insert(articleRevisions)
      .values({
        id: DEMO_IDS.revision,
        articleId: DEMO_IDS.article,
        revisionNumber: 1,
        schemaVersion: 1,
        document,
        documentHash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
        source: 'manual',
        createdByUserId: DEMO_IDS.user,
      })
      .onConflictDoNothing();
    await transaction
      .update(articles)
      .set({ currentRevisionId: DEMO_IDS.revision })
      .where(and(eq(articles.id, DEMO_IDS.article), isNull(articles.currentRevisionId)));
    await transaction
      .insert(conversations)
      .values({
        id: DEMO_IDS.conversation,
        workspaceId: DEMO_IDS.workspace,
        articleId: DEMO_IDS.article,
        title: '长文研究与修改',
      })
      .onConflictDoNothing();
    await transaction
      .update(conversations)
      .set({ articleId: DEMO_IDS.article, title: '长文研究与修改' })
      .where(eq(conversations.id, DEMO_IDS.conversation));
    await transaction
      .insert(conversationBranches)
      .values({ id: DEMO_IDS.branch, conversationId: DEMO_IDS.conversation })
      .onConflictDoNothing();
  });

  const existing = await database
    .select({ id: publications.id })
    .from(publications)
    .where(eq(publications.slug, DEMO_SLUG))
    .limit(1);
  if (!existing[0]) {
    await new PublicationService(database).publish({
      articleId: DEMO_IDS.article,
      revisionId: DEMO_IDS.revision,
      userId: DEMO_IDS.user,
      slug: DEMO_SLUG,
    });
  }
  return DEMO_IDS;
}

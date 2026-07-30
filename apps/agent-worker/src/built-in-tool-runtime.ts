import {
  PersistentToolBridge,
  ToolCallService,
  type RunEventPublisher,
} from '@agentpress/agent-application';
import {
  agentRuns,
  type AgentPressDatabase,
  knowledgeChunks,
  knowledgeDocuments,
  rootRequests,
  workspaceMembers,
} from '@agentpress/database';
import {
  createInMemoryBuiltInDefinitions,
  McpClientGateway,
  McpServerManager,
  registerBuiltInMcpTools,
  type BuiltInSearchHandlers,
} from '@agentpress/mcp-runtime';
import { ToolRegistry } from '@agentpress/tool-runtime';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';

export function createBuiltInToolRuntime(
  database: AgentPressDatabase,
  publisher: RunEventPublisher,
): { readonly bridge: PersistentToolBridge; readonly manager: McpServerManager } {
  const manager = new McpServerManager();
  const handlers = createHandlers(database);
  for (const definition of createInMemoryBuiltInDefinitions(handlers)) manager.register(definition);
  const registry = new ToolRegistry();
  registerBuiltInMcpTools(registry, new McpClientGateway(manager));
  const toolCalls = new ToolCallService({ database, publisher, registry });
  return { bridge: new PersistentToolBridge({ database, registry, toolCalls }), manager };
}

function createHandlers(database: AgentPressDatabase): BuiltInSearchHandlers {
  return {
    web_research: async ({ query, limit }, signal) => {
      const endpoint = new URL('https://zh.wikipedia.org/w/api.php');
      endpoint.search = new URLSearchParams({
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: String(limit),
        format: 'json',
        origin: '*',
      }).toString();
      const payload = await fetchJson(endpoint, signal);
      return normalizeWikiSearch(payload);
    },
    licensed_media: async ({ query, limit }, signal) => {
      const endpoint = new URL('https://commons.wikimedia.org/w/api.php');
      endpoint.search = new URLSearchParams({
        action: 'query',
        generator: 'search',
        gsrsearch: `filetype:bitmap ${query}`,
        gsrnamespace: '6',
        gsrlimit: String(limit),
        prop: 'imageinfo',
        iiprop: 'url|extmetadata',
        format: 'json',
        origin: '*',
      }).toString();
      const payload = await fetchJson(endpoint, signal);
      return normalizeCommonsSearch(payload);
    },
    workspace_knowledge: async ({ query, limit, runId }) => {
      const authorizationRows = await database
        .select({
          workspaceId: agentRuns.workspaceId,
          userId: rootRequests.requestedByUserId,
          role: workspaceMembers.role,
        })
        .from(agentRuns)
        .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
        .leftJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, agentRuns.workspaceId),
            eq(workspaceMembers.userId, rootRequests.requestedByUserId),
          ),
        )
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const authorization = authorizationRows[0];
      if (!authorization?.userId || !authorization.role) {
        throw new Error('Workspace search requires an active requesting member');
      }
      const principals = [
        `user:${authorization.userId}`,
        `role:${authorization.role}`,
        'workspace:members',
      ];
      const rows = await database
        .select({
          chunkId: knowledgeChunks.id,
          source: knowledgeDocuments.sourceUri,
          title: knowledgeDocuments.title,
          revisionHash: knowledgeDocuments.revisionHash,
          contentHash: knowledgeChunks.contentHash,
          text: knowledgeChunks.content,
        })
        .from(knowledgeChunks)
        .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
        .where(
          and(
            eq(knowledgeDocuments.workspaceId, authorization.workspaceId),
            sql`${knowledgeDocuments.acl} ?| array[${sql.join(
              principals.map((principal) => sql`${principal}`),
              sql`, `,
            )}]::text[]`,
            or(
              ilike(knowledgeChunks.content, `%${escapeLike(query)}%`),
              ilike(knowledgeDocuments.title, `%${escapeLike(query)}%`),
            ),
          ),
        )
        .orderBy(desc(knowledgeDocuments.updatedAt), knowledgeChunks.ordinal)
        .limit(limit);
      return rows.map((row) => ({
        evidenceId: `workspace:${row.chunkId}:${row.contentHash}`,
        ...row,
      }));
    },
  };
}

async function fetchJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal,
    headers: { 'user-agent': 'AgentPress/0.1 (local research agent)' },
  });
  if (!response.ok) throw new Error(`Search provider returned HTTP ${String(response.status)}`);
  return response.json() as Promise<unknown>;
}

function normalizeWikiSearch(value: unknown): readonly unknown[] {
  if (!isRecord(value) || !isRecord(value.query) || !Array.isArray(value.query.search)) return [];
  return value.query.search.flatMap((item) => {
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.pageid !== 'number')
      return [];
    return [
      {
        title: item.title,
        url: `https://zh.wikipedia.org/?curid=${String(item.pageid)}`,
        excerpt: typeof item.snippet === 'string' ? stripTags(item.snippet) : '',
        source: 'Wikipedia',
      },
    ];
  });
}

function normalizeCommonsSearch(value: unknown): readonly unknown[] {
  if (!isRecord(value) || !isRecord(value.query) || !isRecord(value.query.pages)) return [];
  return Object.values(value.query.pages).flatMap((page) => {
    if (!isRecord(page) || !Array.isArray(page.imageinfo) || !isRecord(page.imageinfo[0]))
      return [];
    const info = page.imageinfo[0];
    const metadata = isRecord(info.extmetadata) ? info.extmetadata : {};
    return [
      {
        title: typeof page.title === 'string' ? page.title : '',
        url: typeof info.url === 'string' ? info.url : '',
        pageUrl: typeof info.descriptionurl === 'string' ? info.descriptionurl : '',
        license: metadataValue(metadata.LicenseShortName),
        artist: stripTags(metadataValue(metadata.Artist)),
        source: 'Wikimedia Commons',
      },
    ];
  });
}

function metadataValue(value: unknown): string {
  return isRecord(value) && typeof value.value === 'string' ? value.value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

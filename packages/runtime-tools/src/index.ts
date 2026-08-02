import {
  ContextGovernanceService,
  PersistentToolBridge,
  registerContextTools,
  ToolCallService,
  type RunEventPublisher,
} from '@agentpress/agent-application';
import {
  agentRuns,
  type AgentPressDatabase,
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
import { ProposalService, registerArticleTools } from '@agentpress/editor-application';
import {
  ArkEmbeddingProvider,
  ArkRerankProvider,
  PostgresHybridSearch,
} from '@agentpress/knowledge-retrieval';
import { loadWorkerEnvironment } from '@agentpress/config';
import { ArkImageGenerator, MediaService, MinioObjectStorage } from '@agentpress/media-application';
import { Type } from '@sinclair/typebox';
import { fetchPublicImage, fetchResearchSource } from '@agentpress/web-research';
import { and, eq } from 'drizzle-orm';

import { searchPublicSources } from './web-search.js';

export function createBuiltInToolRuntime(
  database: AgentPressDatabase,
  publisher: RunEventPublisher,
): {
  readonly bridge: PersistentToolBridge;
  readonly manager: McpServerManager;
  readonly toolCalls: ToolCallService;
} {
  const manager = new McpServerManager();
  const handlers = createHandlers(database);
  for (const definition of createInMemoryBuiltInDefinitions(handlers)) manager.register(definition);
  const registry = new ToolRegistry();
  registerBuiltInMcpTools(registry, new McpClientGateway(manager));
  registerArticleTools(registry, database, new ProposalService(database));
  registerContextTools(registry, new ContextGovernanceService(database));
  const environment = loadWorkerEnvironment();
  if (environment.arkApiKey && environment.arkImageModel) {
    const media = new MediaService({
      database,
      storage: new MinioObjectStorage(environment.s3),
      imageGenerator: new ArkImageGenerator({
        apiKey: environment.arkApiKey,
        baseUrl: environment.arkBaseUrl,
        model: environment.arkImageModel,
      }),
    });
    registry.register({
      toolId: 'image.generate',
      version: '1.0.0',
      owner: 'agentpress.media',
      description: 'Generate an image, persist it in object storage and return provenance metadata',
      capabilities: ['image.generate'],
      inputSchema: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 4_000 }) }),
      outputSchema: Type.Any(),
      risk: 'external_write',
      sideEffect: 'Calls the configured image model and stores immutable image bytes in MinIO',
      idempotency: 'provider_key',
      timeoutMs: 120_000,
      estimateCost: () => ({ images: 1 }),
      execute: ({ prompt }, context) =>
        media.generateForTool({ toolCallId: context.toolCallId, prompt }),
    });
  }
  const media = new MediaService({
    database,
    storage: new MinioObjectStorage(environment.s3),
    imageGenerator: {
      generate: () => Promise.reject(new Error('Image generation is not configured')),
    },
  });
  registry.register({
    toolId: 'media.import_licensed',
    version: '1.0.0',
    owner: 'agentpress.media',
    description: 'Import a licensed public image into immutable object storage with provenance',
    capabilities: ['licensed_media.import'],
    inputSchema: Type.Object({
      sourceUrl: Type.String({ pattern: '^https://', maxLength: 4_000 }),
      license: Type.String({ minLength: 1, maxLength: 160 }),
      attribution: Type.String({ minLength: 1, maxLength: 2_000 }),
    }),
    outputSchema: Type.Any(),
    risk: 'external_write',
    sideEffect: 'Downloads an approved public image and stores immutable bytes in MinIO',
    idempotency: 'provider_key',
    timeoutMs: 60_000,
    estimateCost: () => ({ externalRequests: 1 }),
    execute: async ({ sourceUrl, license, attribution }, context) => {
      const image = await fetchPublicImage(sourceUrl, { signal: context.signal });
      return media.importLicensedForTool({
        toolCallId: context.toolCallId,
        bytes: image.bytes,
        mimeType: image.mimeType,
        sourceUrl: image.finalUrl,
        license,
        attribution,
      });
    },
  });
  const toolCalls = new ToolCallService({ database, publisher, registry });
  return {
    bridge: new PersistentToolBridge({ database, registry, toolCalls }),
    manager,
    toolCalls,
  };
}

function createHandlers(database: AgentPressDatabase): BuiltInSearchHandlers {
  const environment = loadWorkerEnvironment();
  const embeddings =
    environment.arkApiKey && environment.arkEmbeddingModel
      ? new ArkEmbeddingProvider({
          apiKey: environment.arkApiKey,
          baseUrl: environment.arkBaseUrl,
          model: environment.arkEmbeddingModel,
        })
      : undefined;
  const hybridSearch = new PostgresHybridSearch(database);
  const reranker =
    environment.arkApiKey && environment.arkRerankModel
      ? new ArkRerankProvider({
          apiKey: environment.arkApiKey,
          baseUrl: environment.arkBaseUrl,
          model: environment.arkRerankModel,
        })
      : undefined;
  return {
    web_research: async ({ query, limit }, signal) => {
      const results = await searchPublicSources(query, limit, { signal });
      return Promise.all(
        results.map(async (result) => {
          try {
            const source = await fetchResearchSource(result.url, { signal, maxBytes: 750_000 });
            return {
              ...result,
              title: source.title,
              text: source.text.slice(0, 20_000),
              fetchedAt: source.fetchedAt,
            };
          } catch (error) {
            return {
              ...result,
              fetchError: error instanceof Error ? error.message : 'Source extraction failed',
            };
          }
        }),
      );
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
      if (!embeddings)
        throw new Error('ARK_API_KEY and ARK_EMBEDDING_MODEL are required for workspace RAG');
      const [embedding] = await embeddings.embed([query]);
      if (!embedding) throw new Error('Embedding provider returned no query vector');
      return hybridSearch.search({
        workspaceId: authorization.workspaceId,
        principals,
        query,
        embedding,
        limit,
        ...(reranker
          ? { rerank: (rerankQuery, candidates) => reranker.rerank(rerankQuery, candidates) }
          : {}),
      });
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

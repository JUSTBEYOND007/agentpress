import {
  ContextGovernanceService,
  DirectRunService,
  ToolCallService,
} from '@agentpress/agent-application';
import { loadApiEnvironment } from '@agentpress/config';
import { connectDatabase } from '@agentpress/database';
import type { DatabaseConnection } from '@agentpress/database';
import { AutosaveService, ProposalService, RedisWriterLease } from '@agentpress/editor-application';
import {
  ArkImageGenerator,
  AttachmentService,
  MediaService,
  MinioObjectStorage,
  type ImageGenerator,
} from '@agentpress/media-application';
import { PublicationService } from '@agentpress/publication-application';
import { registerBuiltInMcpTools } from '@agentpress/mcp-runtime';
import type { OnApplicationShutdown, Provider } from '@nestjs/common';
import { ToolRegistry } from '@agentpress/tool-runtime';
import { Redis } from 'ioredis';

import { RedisRunEventBus } from './redis-run-event-bus.js';
import { AuthService } from '../auth/auth.service.js';
import { AuthorizationService } from '../auth/authorization.service.js';

const environment = loadApiEnvironment();
const databaseConnection = connectDatabase(environment.databaseUrl);
const eventBus = new RedisRunEventBus(environment.redisUrl);
const writerRedis = new Redis(environment.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
const writerLease = new RedisWriterLease(writerRedis);
const objectStorage = new MinioObjectStorage(environment.s3);
const imageGenerator: ImageGenerator =
  environment.arkApiKey && environment.arkImageModel
    ? new ArkImageGenerator({
        apiKey: environment.arkApiKey,
        baseUrl: environment.arkBaseUrl,
        model: environment.arkImageModel,
      })
    : {
        generate: () => Promise.reject(new Error('ARK_API_KEY and ARK_IMAGE_MODEL are required')),
      };
const toolRegistry = new ToolRegistry();
registerBuiltInMcpTools(toolRegistry, {
  call: () => Promise.reject(new Error('Tool execution belongs to the Agent Worker')),
});
export const DATABASE_CONNECTION = Symbol('DATABASE_CONNECTION');

class AgentResources implements OnApplicationShutdown {
  public async onApplicationShutdown(): Promise<void> {
    if (writerRedis.status === 'wait') writerRedis.disconnect();
    else await writerRedis.quit();
    await Promise.all([databaseConnection.close(), eventBus.close()]);
  }
}

export const agentProviders: Provider[] = [
  {
    provide: ToolRegistry,
    useValue: toolRegistry,
  },
  {
    provide: DATABASE_CONNECTION,
    useValue: databaseConnection,
  },
  {
    provide: AuthService,
    useFactory: (connection: DatabaseConnection) =>
      new AuthService(connection.db, environment.logtoEndpoint, environment.logtoApiResource),
    inject: [DATABASE_CONNECTION],
  },
  {
    provide: AuthorizationService,
    useFactory: (connection: DatabaseConnection) => new AuthorizationService(connection.db),
    inject: [DATABASE_CONNECTION],
  },
  {
    provide: RedisRunEventBus,
    useValue: eventBus,
  },
  { provide: RedisWriterLease, useValue: writerLease },
  {
    provide: AutosaveService,
    useFactory: (connection: DatabaseConnection, lease: RedisWriterLease) =>
      new AutosaveService(connection.db, lease),
    inject: [DATABASE_CONNECTION, RedisWriterLease],
  },
  {
    provide: ProposalService,
    useFactory: (connection: DatabaseConnection) => new ProposalService(connection.db),
    inject: [DATABASE_CONNECTION],
  },
  {
    provide: PublicationService,
    useFactory: (connection: DatabaseConnection) => new PublicationService(connection.db),
    inject: [DATABASE_CONNECTION],
  },
  {
    provide: MediaService,
    useFactory: (connection: DatabaseConnection) =>
      new MediaService({ database: connection.db, storage: objectStorage, imageGenerator }),
    inject: [DATABASE_CONNECTION],
  },
  {
    provide: AttachmentService,
    useFactory: (connection: DatabaseConnection) =>
      new AttachmentService({ database: connection.db, storage: objectStorage }),
    inject: [DATABASE_CONNECTION],
  },
  {
    provide: ContextGovernanceService,
    useFactory: (connection: DatabaseConnection) => new ContextGovernanceService(connection.db),
    inject: [DATABASE_CONNECTION],
  },
  {
    provide: DirectRunService,
    useFactory: (connection: DatabaseConnection, publisher: RedisRunEventBus) =>
      new DirectRunService({
        database: connection.db,
        publisher,
        runtimeFactory: {
          create() {
            throw new Error('Pi Runtime execution belongs to the Agent Worker');
          },
        },
        systemPrompt: 'You are AgentPress.',
      }),
    inject: [DATABASE_CONNECTION, RedisRunEventBus],
  },
  {
    provide: ToolCallService,
    useFactory: (
      connection: DatabaseConnection,
      publisher: RedisRunEventBus,
      registry: ToolRegistry,
    ) => new ToolCallService({ database: connection.db, publisher, registry }),
    inject: [DATABASE_CONNECTION, RedisRunEventBus, ToolRegistry],
  },
  AgentResources,
];

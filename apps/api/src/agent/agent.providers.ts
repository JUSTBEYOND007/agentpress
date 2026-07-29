import { DirectRunService, ToolCallService } from '@agentpress/agent-application';
import { loadApiEnvironment } from '@agentpress/config';
import { connectDatabase } from '@agentpress/database';
import type { DatabaseConnection } from '@agentpress/database';
import type { OnApplicationShutdown, Provider } from '@nestjs/common';
import { ToolRegistry } from '@agentpress/tool-runtime';

import { RedisRunEventBus } from './redis-run-event-bus.js';

const environment = loadApiEnvironment();
const databaseConnection = connectDatabase(environment.databaseUrl);
const eventBus = new RedisRunEventBus(environment.redisUrl);
const DATABASE_CONNECTION = Symbol('DATABASE_CONNECTION');

class AgentResources implements OnApplicationShutdown {
  public async onApplicationShutdown(): Promise<void> {
    await Promise.all([databaseConnection.close(), eventBus.close()]);
  }
}

export const agentProviders: Provider[] = [
  {
    provide: ToolRegistry,
    useValue: new ToolRegistry(),
  },
  {
    provide: DATABASE_CONNECTION,
    useValue: databaseConnection,
  },
  {
    provide: RedisRunEventBus,
    useValue: eventBus,
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

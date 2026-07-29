import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { HealthController } from './health.controller.js';
import { AgentController } from './agent/agent.controller.js';
import { agentProviders } from './agent/agent.providers.js';
import { EditorController } from './editor/editor.controller.js';
import { MediaController } from './media/media.controller.js';
import { PublicationController } from './publication/publication.controller.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        messageKey: 'message',
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie'],
          censor: '[REDACTED]',
        },
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
      },
    }),
  ],
  controllers: [
    HealthController,
    AgentController,
    EditorController,
    MediaController,
    PublicationController,
  ],
  providers: [...agentProviders],
})
export class AppModule {}

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { loadWorkerEnvironment } from '@agentpress/config';
import { createServiceLogger } from '@agentpress/observability';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const environment = loadWorkerEnvironment();
  const logger = createServiceLogger({
    level: environment.logLevel,
    service: 'async-worker',
  });
  const application = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: true,
    logger: false,
  });

  application.enableShutdownHooks();
  logger.info({ nodeEnv: environment.nodeEnv }, 'Async worker started');
}

void bootstrap();

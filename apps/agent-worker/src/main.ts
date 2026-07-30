import 'reflect-metadata';

import { loadWorkerEnvironment } from '@agentpress/config';
import { createServiceLogger, startTelemetry } from '@agentpress/observability';

async function bootstrap(): Promise<void> {
  const environment = loadWorkerEnvironment();
  const telemetry = await startTelemetry('agent-worker');
  const [{ NestFactory }, { AppModule }] = await Promise.all([
    import('@nestjs/core'),
    import('./app.module.js'),
  ]);
  const logger = createServiceLogger({
    level: environment.logLevel,
    service: 'agent-worker',
  });
  const application = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: true,
    logger: false,
  });

  application.enableShutdownHooks();
  const shutdownTelemetry = (): void => {
    void telemetry.shutdown();
  };
  process.once('SIGINT', shutdownTelemetry);
  process.once('SIGTERM', shutdownTelemetry);
  logger.info({ nodeEnv: environment.nodeEnv }, 'Agent worker started');
}

void bootstrap();

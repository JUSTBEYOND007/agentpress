import 'reflect-metadata';

import { loadApiEnvironment } from '@agentpress/config';
import { startTelemetry } from '@agentpress/observability';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

async function bootstrap(): Promise<void> {
  const environment = loadApiEnvironment();
  const telemetry = await startTelemetry('api');
  const [common, core, fastify, nestPino, application] = await Promise.all([
    import('@nestjs/common'),
    import('@nestjs/core'),
    import('@nestjs/platform-fastify'),
    import('nestjs-pino'),
    import('./app.module.js'),
  ]);
  const app = await core.NestFactory.create<NestFastifyApplication>(
    application.AppModule,
    new fastify.FastifyAdapter({
      bodyLimit: 1_048_576,
      trustProxy: true,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(nestPino.Logger));
  app.enableVersioning({
    defaultVersion: '1',
    type: common.VersioningType.URI,
  });
  app.enableCors({
    origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000,http://localhost:3003')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    credentials: true,
  });
  app.enableShutdownHooks();
  const shutdownTelemetry = (): void => {
    void telemetry.shutdown();
  };
  process.once('SIGINT', shutdownTelemetry);
  process.once('SIGTERM', shutdownTelemetry);

  await app.listen(environment.port, '0.0.0.0');
}

void bootstrap();

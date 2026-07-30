import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import pino, { type Logger } from 'pino';

import type { ServiceName } from '@agentpress/contracts';

export type ServiceLoggerOptions = {
  readonly level: string;
  readonly service: ServiceName;
};

export function createServiceLogger(options: ServiceLoggerOptions): Logger {
  return pino({
    base: {
      service: options.service,
    },
    level: options.level,
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type TelemetryHandle = {
  readonly enabled: boolean;
  readonly shutdown: () => Promise<void>;
};

export function telemetryResourceAttributes(
  service: ServiceName,
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  return {
    [ATTR_SERVICE_NAME]: service,
    [ATTR_SERVICE_VERSION]:
      optionalEnvironmentValue(environment, 'OTEL_SERVICE_VERSION') ?? '0.0.0-dev',
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
      optionalEnvironmentValue(environment, 'NODE_ENV') ?? 'development',
  };
}

export function startTelemetry(
  service: ServiceName,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TelemetryHandle> {
  if (!telemetryEnabled(environment)) {
    return Promise.resolve({ enabled: false, shutdown: () => Promise.resolve() });
  }
  const sdk = new NodeSDK({
    resource: resourceFromAttributes(telemetryResourceAttributes(service, environment)),
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 15_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
  return Promise.resolve({ enabled: true, shutdown: () => sdk.shutdown() });
}

function telemetryEnabled(environment: NodeJS.ProcessEnv): boolean {
  if (environment.OTEL_SDK_DISABLED === 'true') return false;
  const endpoints = [
    environment.OTEL_EXPORTER_OTLP_ENDPOINT,
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  ];
  return endpoints.some((value) => typeof value === 'string' && value.length > 0);
}

function optionalEnvironmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const value: unknown = environment[key];
  return typeof value === 'string' ? value : undefined;
}

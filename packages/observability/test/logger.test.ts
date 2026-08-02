import { describe, expect, it } from 'vitest';

import { createServiceLogger, startTelemetry, telemetryResourceAttributes } from '../src/index.js';

describe('createServiceLogger', () => {
  it('creates a logger with the configured level', () => {
    expect(createServiceLogger({ level: 'warn', service: 'api' }).level).toBe('warn');
  });

  it('builds stable OpenTelemetry resource attributes', () => {
    expect(
      telemetryResourceAttributes('agent-worker', {
        NODE_ENV: 'production',
        OTEL_SERVICE_VERSION: '1.2.3',
      }),
    ).toMatchObject({
      'deployment.environment.name': 'production',
      'service.name': 'agent-worker',
      'service.version': '1.2.3',
    });
  });

  it('stays disabled without an OTLP endpoint', async () => {
    const telemetry = await startTelemetry('api', {});
    expect(telemetry.enabled).toBe(false);
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });
});

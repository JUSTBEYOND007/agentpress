import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const LogLevelSchema = Type.Union([
  Type.Literal('fatal'),
  Type.Literal('error'),
  Type.Literal('warn'),
  Type.Literal('info'),
  Type.Literal('debug'),
  Type.Literal('trace'),
]);

const CommonEnvironmentSchema = Type.Object({
  LOG_LEVEL: Type.Optional(LogLevelSchema),
  NODE_ENV: Type.Optional(
    Type.Union([Type.Literal('development'), Type.Literal('test'), Type.Literal('production')]),
  ),
});

const ApiEnvironmentSchema = Type.Intersect([
  CommonEnvironmentSchema,
  Type.Object({
    API_PORT: Type.Optional(Type.String({ pattern: '^[0-9]{1,5}$' })),
  }),
]);

export type ApiEnvironment = {
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
};

export type WorkerEnvironment = Omit<ApiEnvironment, 'port'>;

function cleanEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
}

function commonValues(source: NodeJS.ProcessEnv): WorkerEnvironment {
  const clean = cleanEnvironment(source);
  if (!Value.Check(CommonEnvironmentSchema, clean)) {
    throw new Error('Invalid common environment configuration');
  }

  return {
    logLevel: clean.LOG_LEVEL ?? 'info',
    nodeEnv: clean.NODE_ENV ?? 'development',
  };
}

export function loadApiEnvironment(source: NodeJS.ProcessEnv = process.env): ApiEnvironment {
  const clean = cleanEnvironment(source);
  if (!Value.Check(ApiEnvironmentSchema, clean)) {
    throw new Error('Invalid API environment configuration');
  }

  const port = Number(clean.API_PORT ?? '4000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('API_PORT must be an integer between 1 and 65535');
  }

  return { ...commonValues(source), port };
}

export function loadWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): WorkerEnvironment {
  return commonValues(source);
}

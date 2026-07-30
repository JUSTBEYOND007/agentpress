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
    DATABASE_URL: Type.Optional(Type.String({ minLength: 1 })),
    REDIS_URL: Type.Optional(Type.String({ minLength: 1 })),
    S3_ENDPOINT: Type.Optional(Type.String({ minLength: 1 })),
    S3_BUCKET: Type.Optional(Type.String({ minLength: 1 })),
    S3_ACCESS_KEY: Type.Optional(Type.String({ minLength: 1 })),
    S3_SECRET_KEY: Type.Optional(Type.String({ minLength: 1 })),
    ARK_API_KEY: Type.Optional(Type.String({ minLength: 1 })),
    ARK_BASE_URL: Type.Optional(Type.String({ minLength: 1 })),
    ARK_IMAGE_MODEL: Type.Optional(Type.String({ minLength: 1 })),
    LOGTO_ENDPOINT: Type.Optional(Type.String({ minLength: 1 })),
    LOGTO_API_RESOURCE: Type.Optional(Type.String({ minLength: 1 })),
  }),
]);

export type ApiEnvironment = {
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly s3: {
    readonly endPoint: string;
    readonly port: number;
    readonly useSSL: boolean;
    readonly bucket: string;
    readonly accessKey: string;
    readonly secretKey: string;
  };
  readonly arkApiKey?: string;
  readonly arkBaseUrl: string;
  readonly arkImageModel?: string;
  readonly logtoEndpoint: string;
  readonly logtoApiResource: string;
};

const WorkerEnvironmentSchema = Type.Intersect([
  CommonEnvironmentSchema,
  Type.Object({
    DATABASE_URL: Type.Optional(Type.String({ minLength: 1 })),
    REDIS_URL: Type.Optional(Type.String({ minLength: 1 })),
    KAFKA_BROKERS: Type.Optional(Type.String({ minLength: 1 })),
    ARK_API_KEY: Type.Optional(Type.String({ minLength: 1 })),
    ARK_BASE_URL: Type.Optional(Type.String({ minLength: 1 })),
    ARK_MODEL_PRO: Type.Optional(Type.String({ minLength: 1 })),
    ARK_EMBEDDING_MODEL: Type.Optional(Type.String({ minLength: 1 })),
  }),
]);

export type WorkerEnvironment = {
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly kafkaBrokers: readonly string[];
  readonly arkApiKey?: string;
  readonly arkBaseUrl: string;
  readonly arkModelPro?: string;
  readonly arkEmbeddingModel?: string;
};

function cleanEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
}

function commonValues(source: NodeJS.ProcessEnv): Pick<WorkerEnvironment, 'logLevel' | 'nodeEnv'> {
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
  const s3Url = new URL(clean.S3_ENDPOINT ?? 'http://localhost:9000');

  return {
    ...commonValues(source),
    port,
    databaseUrl:
      clean.DATABASE_URL ?? 'postgresql://agentpress:agentpress@localhost:5432/agentpress',
    redisUrl: clean.REDIS_URL ?? 'redis://localhost:16379',
    s3: {
      endPoint: s3Url.hostname,
      port: Number(s3Url.port || (s3Url.protocol === 'https:' ? '443' : '80')),
      useSSL: s3Url.protocol === 'https:',
      bucket: clean.S3_BUCKET ?? 'agentpress',
      accessKey: clean.S3_ACCESS_KEY ?? 'agentpress',
      secretKey: clean.S3_SECRET_KEY ?? 'agentpress-local-secret',
    },
    arkBaseUrl: clean.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
    logtoEndpoint: clean.LOGTO_ENDPOINT ?? 'http://localhost:3001',
    logtoApiResource: clean.LOGTO_API_RESOURCE ?? 'http://localhost:4000/api',
    ...(clean.ARK_API_KEY ? { arkApiKey: clean.ARK_API_KEY } : {}),
    ...(clean.ARK_IMAGE_MODEL ? { arkImageModel: clean.ARK_IMAGE_MODEL } : {}),
  };
}

export function loadWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): WorkerEnvironment {
  const clean = cleanEnvironment(source);
  if (!Value.Check(WorkerEnvironmentSchema, clean)) {
    throw new Error('Invalid worker environment configuration');
  }
  const kafkaBrokers = (clean.KAFKA_BROKERS ?? 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
  if (kafkaBrokers.length === 0) {
    throw new Error('KAFKA_BROKERS must contain at least one broker');
  }

  return {
    ...commonValues(source),
    databaseUrl:
      clean.DATABASE_URL ?? 'postgresql://agentpress:agentpress@localhost:5432/agentpress',
    redisUrl: clean.REDIS_URL ?? 'redis://localhost:16379',
    kafkaBrokers,
    arkBaseUrl: clean.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
    ...(clean.ARK_API_KEY ? { arkApiKey: clean.ARK_API_KEY } : {}),
    ...(clean.ARK_MODEL_PRO ? { arkModelPro: clean.ARK_MODEL_PRO } : {}),
    ...(clean.ARK_EMBEDDING_MODEL ? { arkEmbeddingModel: clean.ARK_EMBEDDING_MODEL } : {}),
  };
}

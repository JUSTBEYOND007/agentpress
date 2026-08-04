import { describe, expect, it } from 'vitest';

import { loadApiEnvironment, loadWorkerEnvironment } from '../src/index.js';

describe('loadApiEnvironment', () => {
  it('provides local defaults', () => {
    expect(loadApiEnvironment({})).toEqual({
      logLevel: 'info',
      nodeEnv: 'development',
      port: 4000,
      databaseUrl: 'postgresql://agentpress:agentpress@localhost:5432/agentpress',
      redisUrl: 'redis://localhost:16379',
      s3: {
        endPoint: 'localhost',
        port: 9000,
        useSSL: false,
        bucket: 'agentpress',
        accessKey: 'agentpress',
        secretKey: 'agentpress-local-secret',
      },
      arkBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      logtoEndpoint: 'http://localhost:3001',
      logtoApiResource: 'http://localhost:4000/api',
    });
  });

  it('rejects an invalid port', () => {
    expect(() => loadApiEnvironment({ API_PORT: '70000' })).toThrow(
      'API_PORT must be an integer between 1 and 65535',
    );
  });

  it('parses worker transport and Ark configuration', () => {
    expect(
      loadWorkerEnvironment({
        KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092',
        ARK_API_KEY: 'secret',
        ARK_MODEL_PRO: 'endpoint-id',
        ARK_EMBEDDING_MODEL: 'embedding-endpoint-id',
      }),
    ).toMatchObject({
      kafkaBrokers: ['kafka-1:9092', 'kafka-2:9092'],
      arkApiKey: 'secret',
      arkModelPro: 'endpoint-id',
      arkEmbeddingModel: 'embedding-endpoint-id',
    });
  });

  it('treats empty optional values from the example env as unconfigured', () => {
    expect(
      loadWorkerEnvironment({
        ARK_API_KEY: '',
        ARK_MODEL_PRO: '',
        ARK_RERANK_MODEL: '',
      }),
    ).not.toHaveProperty('arkApiKey');
  });

  it('keeps an OpenAI-compatible Agent model separate from Ark media models', () => {
    expect(
      loadWorkerEnvironment({
        AGENT_MODEL_API_KEY: 'agent-secret',
        AGENT_MODEL_BASE_URL: 'https://models.example/v1',
        AGENT_MODEL_PRO: 'model-pro',
        AGENT_MODEL_TURBO: 'model-turbo',
        ARK_API_KEY: 'ark-secret',
        ARK_EMBEDDING_MODEL: 'ark-embedding',
      }),
    ).toMatchObject({
      agentModelApiKey: 'agent-secret',
      agentModelBaseUrl: 'https://models.example/v1',
      agentModelPro: 'model-pro',
      agentModelTurbo: 'model-turbo',
      arkApiKey: 'ark-secret',
      arkEmbeddingModel: 'ark-embedding',
    });
  });

  it('rejects a partial Agent model configuration', () => {
    expect(() =>
      loadWorkerEnvironment({
        AGENT_MODEL_API_KEY: 'agent-secret',
        AGENT_MODEL_PRO: 'model-pro',
      }),
    ).toThrow('must be configured together');
  });
});

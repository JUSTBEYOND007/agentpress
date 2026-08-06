import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import type { ProviderToolSchemaCapability } from './provider-tool-schema-codec.js';

export type OpenAICompatibleRuntimeConfig = {
  readonly providerId: string;
  readonly providerName: string;
  readonly apiKey?: string;
  readonly apiKeyEnvironmentVariable?: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly modelName?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly inputCostPerMillion?: number;
  readonly outputCostPerMillion?: number;
  readonly acceptsStrictTools: boolean;
  readonly enforcesStrictTools: boolean;
};

export type OpenAICompatibleBackend = {
  readonly models: Models;
  readonly model: Model<'openai-completions'>;
  readonly toolSchemaCapability: ProviderToolSchemaCapability;
};

function staticApiKeyAuth(providerName: string, apiKey: string) {
  return {
    name: `${providerName} API key`,
    resolve: () => Promise.resolve({ auth: { apiKey } }),
  };
}

export function createOpenAICompatibleBackend(
  config: OpenAICompatibleRuntimeConfig,
): OpenAICompatibleBackend {
  const model: Model<'openai-completions'> = {
    id: config.modelId,
    name: config.modelName ?? config.modelId,
    api: 'openai-completions',
    provider: config.providerId,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: {
      input: config.inputCostPerMillion ?? 0,
      output: config.outputCostPerMillion ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxTokens ?? 16_384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: config.acceptsStrictTools,
    },
  };
  const provider = createProvider({
    id: config.providerId,
    name: config.providerName,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: config.apiKey
        ? staticApiKeyAuth(config.providerName, config.apiKey)
        : envApiKeyAuth(`${config.providerName} API key`, [
            config.apiKeyEnvironmentVariable ?? 'AGENT_MODEL_API_KEY',
          ]),
    },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const registeredModel = models.getModel(config.providerId, config.modelId);

  if (registeredModel?.api !== 'openai-completions') {
    throw new Error(`${config.providerName} model ${config.modelId} was not registered`);
  }

  return {
    models,
    model,
    toolSchemaCapability: {
      dialect: 'openai',
      acceptsStrictTools: config.acceptsStrictTools,
      enforcesStrictTools: config.enforcesStrictTools,
    },
  };
}

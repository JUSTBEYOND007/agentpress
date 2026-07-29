import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export type ArkRuntimeConfig = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly modelId: string;
  readonly modelName?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly inputCostPerMillion?: number;
  readonly outputCostPerMillion?: number;
};

export type ArkBackend = {
  readonly models: Models;
  readonly model: Model<'openai-completions'>;
};

function staticApiKeyAuth(apiKey: string) {
  return {
    name: 'Volcengine Ark API key',
    resolve: () => Promise.resolve({ auth: { apiKey } }),
  };
}

export function createArkBackend(config: ArkRuntimeConfig): ArkBackend {
  const baseUrl = config.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3';
  const model: Model<'openai-completions'> = {
    id: config.modelId,
    name: config.modelName ?? config.modelId,
    api: 'openai-completions',
    provider: 'volcengine-ark',
    baseUrl,
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
      supportsStrictMode: true,
    },
  };
  const provider = createProvider({
    id: 'volcengine-ark',
    name: 'Volcengine Ark',
    baseUrl,
    auth: {
      apiKey: config.apiKey
        ? staticApiKeyAuth(config.apiKey)
        : envApiKeyAuth('Volcengine Ark API key', ['ARK_API_KEY']),
    },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const registeredModel = models.getModel('volcengine-ark', config.modelId);

  if (registeredModel?.api !== 'openai-completions') {
    throw new Error(`Ark model ${config.modelId} was not registered`);
  }

  return { models, model };
}
